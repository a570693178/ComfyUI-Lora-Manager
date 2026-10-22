import { showToast } from '../utils/uiHelpers.js';
import { translate } from '../utils/i18nHelpers.js';
import { getModelApiClient } from '../api/modelApiFactory.js';
import { MODEL_TYPES } from '../api/apiConfig.js';
import { state } from '../state/index.js';

/**
 * Manager for the "Undownloaded Versions" view.
 *
 * Instead of a modal, the pending versions are rendered as cards in the same
 * grid as the regular model list (see createUndownloadedVersionCard), so the
 * view is entered by toggling the toolbar button and left by toggling it
 * again. Selection state lives here and is resolved against every version the
 * grid has loaded so far, which keeps "select all" and "download" correct
 * across pagination.
 *
 * An ignored version stops showing up in the list (the ignore flag is
 * persisted server-side per version).
 */
export class UndownloadedVersionsManager {
    constructor() {
        this.apiClient = null;
        this.modelType = MODEL_TYPES.LORA;
        this.selected = new Set();
        // Every version fetched so far, keyed by `${modelId}:${versionId}`.
        // The grid only keeps the DOM for what is on screen, so selections
        // must be resolved against this map rather than the DOM.
        this.loaded = new Map();
        this.busy = false;
    }

    /**
     * Bind the manager to a page. Called by PageControls when the toolbar
     * button is wired up.
     * @param {string} modelType - one of MODEL_TYPES
     */
    bind(modelType = MODEL_TYPES.LORA) {
        this.modelType = modelType;
        this.apiClient = getModelApiClient(modelType);
    }

    /**
     * Reload the grid from page 1. PageControls owns the scroller, and it is
     * exposed on window by every model page.
     */
    _reloadGrid() {
        this.clearLoaded();
        this.syncToolbar();
        if (typeof window.pageControls?.resetAndReload === 'function') {
            window.pageControls.resetAndReload();
        }
    }

    /**
     * Whether the pending view is currently shown for a page.
     * @param {string} [modelType]
     */
    isActive(modelType = this.modelType) {
        const pageState = this._pageState(modelType);
        return Boolean(pageState?.undownloadedView);
    }

    /**
     * Record a page of versions the grid just loaded. Called from
     * fetchUndownloadedVersions so the manager always knows the full set of
     * fetched entries, not only the visible ones.
     */
    trackLoaded(versions) {
        if (!Array.isArray(versions)) return;
        versions.forEach((version) => {
            this.loaded.set(this._key(version), version);
        });
    }

    clearLoaded() {
        this.loaded.clear();
        this.selected.clear();
    }

    isSelected(key) {
        return this.selected.has(key);
    }

    isDownloadable(version) {
        const control = version?.usageControl;
        if (!control) return true;
        return control === 'Download';
    }

    /**
     * Toggle one version and refresh the toolbar. The visible cards are
     * re-rendered so the checkbox and the highlight follow the new state.
     */
    toggleVersion(key, selected) {
        if (selected) {
            this.selected.add(key);
        } else {
            this.selected.delete(key);
        }
        this.syncToolbar();
        this._rerenderGrid();
    }

    /**
     * Select or clear every loaded, downloadable version.
     * @param {boolean} select
     */
    toggleSelectAll(select) {
        if (!select) {
            this.selected.clear();
        } else {
            this.loaded.forEach((version, key) => {
                if (this.isDownloadable(version)) {
                    this.selected.add(key);
                }
            });
        }
        this.syncToolbar();
        // Re-render so the checkboxes and card highlight follow the new state.
        this._rerenderGrid();
    }

    get selectedCount() {
        return this.selected.size;
    }

    get loadedCount() {
        return this.loaded.size;
    }

    get selectAllState() {
        const downloadable = [...this.loaded.values()].filter((version) =>
            this.isDownloadable(version)
        );
        if (!downloadable.length) {
            return { checked: false, indeterminate: false, disabled: true };
        }
        const selectedDownloadable = downloadable.filter((version) =>
            this.selected.has(this._key(version))
        ).length;
        return {
            checked: selectedDownloadable === downloadable.length,
            indeterminate: selectedDownloadable > 0 && selectedDownloadable < downloadable.length,
            disabled: false,
        };
    }

    _selectedVersions() {
        const versions = [];
        this.selected.forEach((key) => {
            const version = this.loaded.get(key);
            if (version) versions.push(version);
        });
        return versions;
    }

    /**
     * Mark the selected versions as ignored so they leave the pending list.
     */
    async ignoreSelected() {
        const targets = this._selectedVersions();
        if (!targets.length || this.busy) return;

        this.busy = true;
        this.syncToolbar();

        let ignored = 0;
        let failed = 0;
        for (const version of targets) {
            try {
                await this.apiClient.setVersionUpdateIgnore(
                    version.modelId,
                    version.versionId,
                    true
                );
                ignored++;
            } catch (error) {
                console.error('Failed to ignore version:', error);
                failed++;
            }
        }

        this.busy = false;
        this._afterBulkAction();

        if (failed === 0) {
            showToast('toast.undownloadedVersions.ignored', { count: ignored }, 'success');
        } else {
            showToast(
                'toast.undownloadedVersions.ignorePartial',
                { completed: ignored, total: targets.length },
                'warning'
            );
        }
    }

    /**
     * Download the selected versions sequentially.
     *
     * The download endpoint only answers once the whole file has been
     * transferred, so the progress can only come from the download-progress
     * WebSocket. The whole batch shares one download id, and because the
     * files are downloaded one after another, the version that is currently
     * in flight is the one the events belong to.
     */
    async downloadSelected() {
        const targets = this._selectedVersions().filter((version) =>
            this.isDownloadable(version)
        );
        if (!targets.length) {
            showToast('toast.undownloadedVersions.nothingSelected', {}, 'warning');
            return;
        }
        if (this.busy) return;

        const root = await this._resolveRoot();
        if (!root) {
            showToast('toast.undownloadedVersions.noRoot', {}, 'error');
            return;
        }

        this.busy = true;
        this.syncToolbar();

        const loadingManager = state.loadingManager;
        const batchDownloadId = `undl-${Date.now()}`;
        const updateProgress = loadingManager
            ? loadingManager.showDownloadProgress(targets.length)
            : () => {};

        let completed = 0;
        let failed = 0;
        let skippedBefore = 0;
        let skippedByBaseModel = 0;
        let cancelled = false;
        // The batch shares a single download id, so a progress event cannot
        // name the version it belongs to. The downloads run one after
        // another, so the in-flight one is the only candidate.
        let currentName = '';

        const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        let ws = null;
        try {
            ws = new WebSocket(
                `${wsProtocol}${window.location.host}/ws/download-progress?id=${batchDownloadId}`
            );
        } catch (error) {
            console.error('Failed to open download progress socket:', error);
        }

        if (ws) {
            ws.onmessage = (event) => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (error) {
                    return;
                }
                if (data.type === 'download_id') return;
                if (data.status === 'cancelled') {
                    cancelled = true;
                    return;
                }
                if (data.status !== 'progress') return;

                updateProgress(data.progress, completed, currentName, {
                    bytesDownloaded: data.bytes_downloaded,
                    totalBytes: data.total_bytes,
                    bytesPerSecond: data.bytes_per_second,
                });
            };
            ws.onerror = (error) => {
                console.error('Download progress WebSocket error:', error);
            };
            // The socket has to be registered with the server before the
            // first download starts, otherwise the opening progress events
            // of that file are dropped. A socket that never opens must not
            // block the download itself, so the error resolves it too.
            await new Promise((resolve) => {
                const ready = () => resolve();
                ws.addEventListener('open', ready, { once: true });
                ws.addEventListener('error', ready, { once: true });
            });
        }

        if (loadingManager) {
            loadingManager.showCancelButton(async () => {
                if (cancelled) return;
                cancelled = true;
                try {
                    await this.apiClient.cancelDownload(batchDownloadId);
                } catch (error) {
                    console.error('Cancel request failed:', error);
                }
            });
        }

        try {
            for (const version of targets) {
                if (cancelled) break;
                currentName = `${version.modelName || ''} ${version.versionName || version.versionId}`.trim();
                if (loadingManager) {
                    loadingManager.setStatus(
                        translate(
                            'modals.download.status.downloadingFile',
                            { type: this.apiClient?.apiConfig?.config?.singularName || 'model' },
                            'Downloading {type} file'
                        )
                    );
                }
                try {
                    const response = await this.apiClient.downloadModel(
                        version.modelId,
                        version.versionId,
                        root,
                        '',
                        true,
                        batchDownloadId
                    );
                    if (cancelled) break;
                    if (response?.skipped) {
                        // The server refused the transfer (already downloaded
                        // before, or the base model is excluded). Nothing was
                        // written, so this is not a completed download.
                        if (response.reason === 'base_model_excluded') {
                            skippedByBaseModel++;
                        } else {
                            skippedBefore++;
                        }
                    } else if (!response || response.success === false) {
                        failed++;
                    } else {
                        completed++;
                    }
                } catch (error) {
                    console.error('Failed to download version:', error);
                    failed++;
                }
            }
        } finally {
            if (ws) {
                ws.close();
            }
            if (loadingManager) {
                loadingManager.hide();
            }
        }

        this.busy = false;
        this._afterBulkAction();

        if (cancelled) {
            showToast('toast.downloads.downloadStopped', {}, 'info');
        } else if (failed === 0 && skippedBefore === 0 && skippedByBaseModel === 0) {
            showToast(
                'toast.undownloadedVersions.downloadSuccess',
                { count: completed },
                'success'
            );
        } else {
            showToast(
                'toast.undownloadedVersions.downloadPartial',
                { completed, total: targets.length },
                'warning'
            );
        }
        if (skippedBefore > 0) {
            showToast(
                'toast.undownloadedVersions.downloadSkipped',
                { count: skippedBefore },
                'warning'
            );
        }
        if (skippedByBaseModel > 0) {
            showToast(
                'toast.undownloadedVersions.downloadSkippedBaseModel',
                { count: skippedByBaseModel },
                'warning'
            );
        }
    }

    /**
     * After a bulk action the pending set changed, so drop the stale entries
     * and reload page 1 — the counts in the toolbar and the cards both come
     * from the server.
     */
    _afterBulkAction() {
        this.selected.clear();
        this._reloadGrid();
    }

    _key(version) {
        return `${version.modelId}:${version.versionId}`;
    }

    async _resolveRoot() {
        try {
            const rootsData = await this.apiClient.fetchModelRoots();
            const roots = rootsData?.roots || [];
            if (!roots.length) return null;

            // Each model type has its own default-root setting key.
            const defaultRootKey = {
                [MODEL_TYPES.LORA]: 'default_lora_root',
                [MODEL_TYPES.CHECKPOINT]: 'default_checkpoint_root',
                [MODEL_TYPES.EMBEDDING]: 'default_embedding_root',
            }[this.modelType];
            const defaultRoot = defaultRootKey
                ? state.global?.settings?.[defaultRootKey]
                : '';
            if (defaultRoot && roots.includes(defaultRoot)) {
                return defaultRoot;
            }
            return roots[0];
        } catch (error) {
            console.error('Failed to resolve model root:', error);
            return null;
        }
    }

    _pageState(modelType = this.modelType) {
        const key = (modelType || MODEL_TYPES.LORA).toLowerCase();
        return state.pages?.[key];
    }

    /**
     * Push the selection summary into the bar above the grid.
     * Public: PageControls calls it right after entering the view so the
     * summary reads 0 / 0 before the first page lands.
     */
    syncToolbar() {
        const summaryEl = document.getElementById('undownloadedViewSummary');
        if (summaryEl) {
            summaryEl.textContent = translate(
                'modals.undownloadedVersions.summary',
                { selected: this.selectedCount, total: this.loadedCount },
                `${this.selectedCount} / ${this.loadedCount} selected`
            );
        }

        const selectAllEl = document.getElementById('undownloadedViewSelectAll');
        if (selectAllEl) {
            const { checked, indeterminate, disabled } = this.selectAllState;
            selectAllEl.checked = checked;
            selectAllEl.indeterminate = indeterminate;
            selectAllEl.disabled = disabled || this.busy;
        }

        const downloadBtn = document.getElementById('undownloadedViewDownloadBtn');
        if (downloadBtn) {
            // Downloading requires an explicit selection.
            downloadBtn.disabled = this.selectedCount === 0 || this.busy;
            const textEl = document.getElementById('undownloadedViewDownloadBtnText');
            if (textEl) {
                textEl.textContent = translate(
                    'modals.undownloadedVersions.downloadSelected',
                    { count: this.selectedCount },
                    `Download selected (${this.selectedCount})`
                );
            }
        }

        const ignoreBtn = document.getElementById('undownloadedViewIgnoreBtn');
        if (ignoreBtn) {
            ignoreBtn.disabled = this.selectedCount === 0 || this.busy;
            const textEl = document.getElementById('undownloadedViewIgnoreBtnText');
            if (textEl) {
                textEl.textContent = translate(
                    'modals.undownloadedVersions.ignoreSelected',
                    { count: this.selectedCount },
                    `Ignore selected (${this.selectedCount})`
                );
            }
        }
    }

    /** Re-render the grid in place (selection changed, data did not). */
    _rerenderGrid() {
        const scroller = state.virtualScroller;
        if (!scroller) return;
        if (typeof scroller.refreshWithData === 'function') {
            scroller.refreshWithData(scroller.items, scroller.totalItems, scroller.hasMore);
        }
    }

    /** Re-fetch page 1 from the server (pending set changed). */
    _reloadGrid() {
        this.clearLoaded();
        this.syncToolbar();
        if (typeof window.pageControls?.resetAndReload === 'function') {
            window.pageControls.resetAndReload();
        }
    }
}

export const undownloadedVersionsManager = new UndownloadedVersionsManager();

// Exposed on window (same convention as pageControls / modelDuplicatesManager)
// so BaseModelApiClient can report fetched pages without importing this module
// back — modelApiFactory -> baseModelApi -> this module would be a cycle.
if (typeof window !== 'undefined') {
    window.undownloadedVersionsManager = undownloadedVersionsManager;
}
