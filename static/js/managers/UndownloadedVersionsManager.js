import { showToast } from '../utils/uiHelpers.js';
import { translate } from '../utils/i18nHelpers.js';
import { getModelApiClient } from '../api/modelApiFactory.js';
import { MODEL_TYPES } from '../api/apiConfig.js';
import { state } from '../state/index.js';
import { modalManager } from './ModalManager.js';

/**
 * Manager for the "Undownloaded Versions" panel.
 *
 * Lists every remote version of the local models that is not present in the
 * library yet, lets the user pick entries, then either downloads the picked
 * ones or ignores them. An ignored version stops showing up in the list
 * (the ignore flag is persisted server-side per version).
 */
export class UndownloadedVersionsManager {
    constructor() {
        this.apiClient = null;
        this.modelType = MODEL_TYPES.LORA;
        this.versions = [];
        this.selected = new Set();
        this.busy = false;
    }

    /**
     * Bind the manager to a page and open the panel.
     * @param {string} modelType - one of MODEL_TYPES
     */
    async open(modelType = MODEL_TYPES.LORA) {
        this.modelType = modelType;
        this.apiClient = getModelApiClient(modelType);
        this.selected.clear();

        const listEl = document.getElementById('undownloadedVersionsList');
        if (listEl) {
            listEl.innerHTML = `<div class="undownloaded-versions-loading">${translate(
                'common.status.loading',
                {},
                'Loading...'
            )}</div>`;
        }
        this._updateToolbar();

        modalManager.showModal('undownloadedVersionsModal');

        try {
            const response = await this.apiClient.fetchUndownloadedVersions();
            this.versions = Array.isArray(response?.versions) ? response.versions : [];
        } catch (error) {
            console.error('Failed to load undownloaded versions:', error);
            this.versions = [];
            showToast('toast.undownloadedVersions.loadFailed', {}, 'error');
        }

        this._render();
    }

    _render() {
        const listEl = document.getElementById('undownloadedVersionsList');
        if (!listEl) return;

        if (!this.versions.length) {
            listEl.innerHTML = `<div class="undownloaded-versions-empty">${translate(
                'modals.undownloadedVersions.empty',
                {},
                'All versions are already downloaded.'
            )}</div>`;
            this._updateToolbar();
            return;
        }

        listEl.innerHTML = this.versions.map((version) => {
            const key = this._key(version);
            const checked = this.selected.has(key);
            const downloadable = this._isDownloadable(version);
            const badges = [];
            if (version.isEarlyAccess) {
                badges.push(`<span class="undownloaded-version-badge is-early-access">${translate(
                    'modals.undownloadedVersions.badgeEarlyAccess',
                    {},
                    'Early Access'
                )}</span>`);
            }
            if (version.isPaid) {
                badges.push(`<span class="undownloaded-version-badge is-paid">${translate(
                    'modals.undownloadedVersions.badgePaid',
                    {},
                    'Paid'
                )}</span>`);
            }
            if (!downloadable) {
                badges.push(`<span class="undownloaded-version-badge is-locked">${translate(
                    'modals.undownloadedVersions.badgeNotDownloadable',
                    {},
                    'Not downloadable'
                )}</span>`);
            }
            const preview = version.previewUrl
                ? `<img class="undownloaded-version-preview" src="${this._escapeAttr(version.previewUrl)}" alt="" loading="lazy">`
                : `<span class="undownloaded-version-preview is-placeholder"><i class="fas fa-image"></i></span>`;
            const versionLabel = version.versionName
                ? version.versionName
                : `#${version.versionId}`;
            return `
                <label class="undownloaded-version-item${checked ? ' is-selected' : ''}${downloadable ? '' : ' is-locked'}" data-version-key="${this._escapeAttr(key)}">
                    <input type="checkbox" class="undownloaded-version-checkbox" data-version-key="${this._escapeAttr(key)}"${checked ? ' checked' : ''}${downloadable ? '' : ' disabled'}>
                    ${preview}
                    <span class="undownloaded-version-info">
                        <span class="undownloaded-version-model">${this._escapeHtml(version.modelName || '')}</span>
                        <span class="undownloaded-version-name">${this._escapeHtml(versionLabel)}</span>
                        ${badges.length ? `<span class="undownloaded-version-badges">${badges.join('')}</span>` : ''}
                    </span>
                </label>
            `;
        }).join('');

        listEl.querySelectorAll('.undownloaded-version-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', (event) => {
                const key = event.target.dataset.versionKey;
                if (!key) return;
                if (event.target.checked) {
                    this.selected.add(key);
                } else {
                    this.selected.delete(key);
                }
                const row = event.target.closest('.undownloaded-version-item');
                if (row) row.classList.toggle('is-selected', event.target.checked);
                this._updateToolbar();
            });
        });

        this._updateToolbar();
    }

    _updateToolbar() {
        const total = this.versions.length;
        const selectedCount = this.selected.size;

        const summaryEl = document.getElementById('undownloadedVersionsSummary');
        if (summaryEl) {
            summaryEl.textContent = translate(
                'modals.undownloadedVersions.summary',
                { selected: selectedCount, total },
                `${selectedCount} / ${total} selected`
            );
        }

        const selectAllEl = document.getElementById('undownloadedVersionsSelectAll');
        if (selectAllEl) {
            selectAllEl.checked = total > 0 && selectedCount === total;
            selectAllEl.indeterminate = selectedCount > 0 && selectedCount < total;
            selectAllEl.disabled = total === 0;
        }

        const downloadBtn = document.getElementById('undownloadedVersionsDownloadBtn');
        if (downloadBtn) {
            // Downloading requires an explicit selection.
            downloadBtn.disabled = selectedCount === 0 || this.busy;
            const textEl = document.getElementById('undownloadedVersionsDownloadBtnText');
            if (textEl) {
                textEl.textContent = translate(
                    'modals.undownloadedVersions.downloadSelected',
                    { count: selectedCount },
                    `Download selected (${selectedCount})`
                );
            }
        }

        const ignoreBtn = document.getElementById('undownloadedVersionsIgnoreBtn');
        if (ignoreBtn) {
            ignoreBtn.disabled = selectedCount === 0 || this.busy;
            const textEl = document.getElementById('undownloadedVersionsIgnoreBtnText');
            if (textEl) {
                textEl.textContent = translate(
                    'modals.undownloadedVersions.ignoreSelected',
                    { count: selectedCount },
                    `Ignore selected (${selectedCount})`
                );
            }
        }
    }

    toggleSelectAll(checked) {
        this.selected.clear();
        if (checked) {
            this.versions.forEach((version) => {
                if (this._isDownloadable(version)) {
                    this.selected.add(this._key(version));
                }
            });
        }
        this._render();
    }

    /**
     * A version can only be fetched when CivitAI allows direct downloads.
     * "Generation" / "InternalGeneration" versions stay listed but cannot
     * be picked, so the download action never targets them.
     */
    _isDownloadable(version) {
        const control = version?.usageControl;
        if (!control) return true;
        return control === 'Download';
    }

    /**
     * Mark the selected versions as ignored so they leave the pending list.
     */
    async ignoreSelected() {
        const targets = this._selectedVersions();
        if (!targets.length) return;

        this.busy = true;
        this._updateToolbar();

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

        // Drop the ignored entries locally, then re-read the list so the
        // server-side filter is the single source of truth.
        const ignoredKeys = new Set(targets.map((version) => this._key(version)));
        this.versions = this.versions.filter((version) => !ignoredKeys.has(this._key(version)));
        this.selected.clear();
        this._render();

        try {
            const response = await this.apiClient.fetchUndownloadedVersions();
            this.versions = Array.isArray(response?.versions) ? response.versions : [];
        } catch (error) {
            console.error('Failed to refresh undownloaded versions:', error);
        }
        this._render();

        if (failed === 0) {
            showToast(
                'toast.undownloadedVersions.ignored',
                { count: ignored },
                'success'
            );
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
     */
    async downloadSelected() {
        const targets = this._selectedVersions().filter(
            (version) => this._isDownloadable(version)
        );
        if (!targets.length) {
            showToast('toast.undownloadedVersions.nothingSelected', {}, 'warning');
            return;
        }

        const root = await this._resolveRoot();
        if (!root) {
            showToast('toast.undownloadedVersions.noRoot', {}, 'error');
            return;
        }

        this.busy = true;
        this._updateToolbar();

        const loadingManager = state.loadingManager;
        const batchDownloadId = `undl-${Date.now()}`;
        const updateProgress = loadingManager
            ? loadingManager.showDownloadProgress(targets.length)
            : () => {};

        let completed = 0;
        let failed = 0;

        for (const version of targets) {
            try {
                const response = await this.apiClient.downloadModel(
                    version.modelId,
                    version.versionId,
                    root,
                    '',
                    true,
                    batchDownloadId
                );
                if (!response || response.success === false) {
                    failed++;
                } else {
                    completed++;
                }
            } catch (error) {
                console.error('Failed to download version:', error);
                failed++;
            }
            updateProgress(
                Math.round(((completed + failed) / targets.length) * 100),
                completed + failed,
                `${version.modelName || ''} ${version.versionName || version.versionId}`
            );
        }

        if (loadingManager) {
            loadingManager.hide();
        }
        this.busy = false;

        // Refresh the list: downloaded entries are gone, the rest stay.
        try {
            const response = await this.apiClient.fetchUndownloadedVersions();
            this.versions = Array.isArray(response?.versions) ? response.versions : [];
        } catch (error) {
            console.error('Failed to refresh undownloaded versions:', error);
        }
        this.selected.clear();
        this._render();

        if (failed === 0) {
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
    }

    _selectedVersions() {
        return this.versions.filter((version) => this.selected.has(this._key(version)));
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

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _escapeAttr(value) {
        return this._escapeHtml(value).replace(/`/g, '&#96;');
    }
}

export const undownloadedVersionsManager = new UndownloadedVersionsManager();

if (typeof window !== 'undefined') {
    window.undownloadedVersionsManager = undownloadedVersionsManager;

    // Wire the panel controls once the DOM is ready. The markup lives in a
    // Jinja template, so the elements may not exist at import time.
    const bindPanelControls = () => {
        const selectAllEl = document.getElementById('undownloadedVersionsSelectAll');
        if (selectAllEl && !selectAllEl.dataset.bound) {
            selectAllEl.dataset.bound = 'true';
            selectAllEl.addEventListener('change', (event) => {
                undownloadedVersionsManager.toggleSelectAll(event.target.checked);
            });
        }

        const downloadBtn = document.getElementById('undownloadedVersionsDownloadBtn');
        if (downloadBtn && !downloadBtn.dataset.bound) {
            downloadBtn.dataset.bound = 'true';
            downloadBtn.addEventListener('click', () => {
                undownloadedVersionsManager.downloadSelected();
            });
        }

        const ignoreBtn = document.getElementById('undownloadedVersionsIgnoreBtn');
        if (ignoreBtn && !ignoreBtn.dataset.bound) {
            ignoreBtn.dataset.bound = 'true';
            ignoreBtn.addEventListener('click', () => {
                undownloadedVersionsManager.ignoreSelected();
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindPanelControls);
    } else {
        bindPanelControls();
    }
}
