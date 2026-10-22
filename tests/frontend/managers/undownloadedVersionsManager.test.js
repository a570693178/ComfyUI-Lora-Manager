import { describe, it, beforeEach, expect, vi } from 'vitest';

const {
    MANAGER_MODULE,
    MODEL_API_FACTORY_MODULE,
    I18N_MODULE,
    API_CONFIG_MODULE,
    STATE_MODULE,
    UI_HELPERS_MODULE,
    CARD_MODULE,
} = vi.hoisted(() => ({
    MANAGER_MODULE: new URL('../../../static/js/managers/UndownloadedVersionsManager.js', import.meta.url).pathname,
    MODEL_API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
    I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
    API_CONFIG_MODULE: new URL('../../../static/js/api/apiConfig.js', import.meta.url).pathname,
    STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
    UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
    CARD_MODULE: new URL('../../../static/js/components/shared/UndownloadedVersionCard.js', import.meta.url).pathname,
}));

vi.mock(MODEL_API_FACTORY_MODULE, () => ({ getModelApiClient: vi.fn() }));
vi.mock(I18N_MODULE, () => ({ translate: (key, _args, fallback) => fallback || key }));
vi.mock(UI_HELPERS_MODULE, () => ({ showToast: vi.fn() }));
// state/index.js builds its page map from MODEL_TYPES at import time, so the
// real apiConfig (which imports the state) would be a cycle. Mock it with just
// the constants the modules under test read.
vi.mock(API_CONFIG_MODULE, () => ({
    MODEL_TYPES: { LORA: 'loras', CHECKPOINT: 'checkpoints', EMBEDDING: 'embeddings', OTHER: 'other' },
}));
// The card module pulls the manager back in; stub it so this test can import
// either module without a cycle.
vi.mock(CARD_MODULE, () => ({ createUndownloadedVersionCard: vi.fn() }));

const { undownloadedVersionsManager } = await import(MANAGER_MODULE);
const { MODEL_TYPES } = await import(API_CONFIG_MODULE);
const { state } = await import(STATE_MODULE);

/** A pending version with every field the manager reads. */
function makeVersion(modelId, versionId, overrides = {}) {
    return {
        modelId,
        modelName: `Model ${modelId}`,
        versionId,
        versionName: `v${versionId}`,
        baseModel: 'Illustrious',
        previewUrl: null,
        isEarlyAccess: false,
        isPaid: false,
        usageControl: 'Download',
        releasedAt: null,
        ...overrides,
    };
}

function setToolbarDom() {
    document.body.innerHTML = `
        <input type="checkbox" id="undownloadedViewSelectAll">
        <span id="undownloadedViewSummary"></span>
        <button id="undownloadedViewDownloadBtn" disabled>
            <span id="undownloadedViewDownloadBtnText"></span>
        </button>
        <button id="undownloadedViewIgnoreBtn" disabled>
            <span id="undownloadedViewIgnoreBtnText"></span>
        </button>
    `;
}

describe('UndownloadedVersionsManager', () => {
    beforeEach(() => {
        undownloadedVersionsManager.clearLoaded();
        undownloadedVersionsManager.busy = false;
        setToolbarDom();
        state.pages = state.pages || {};
        state.pages.loras = { ...(state.pages.loras || {}), undownloadedView: false };
    });

    describe('selection state', () => {
        it('tracks loaded versions and toggles a single entry', () => {
            const v1 = makeVersion(7, 2);
            const v2 = makeVersion(8, 3);
            undownloadedVersionsManager.trackLoaded([v1, v2]);

            expect(undownloadedVersionsManager.loadedCount).toBe(2);
            expect(undownloadedVersionsManager.isSelected('7:2')).toBe(false);

            undownloadedVersionsManager.toggleVersion('7:2', true);

            expect(undownloadedVersionsManager.isSelected('7:2')).toBe(true);
            expect(undownloadedVersionsManager.selectedCount).toBe(1);
            expect(document.getElementById('undownloadedViewSummary').textContent)
                .toBe('1 / 2 selected');
        });

        it('enables download only once something is selected', () => {
            undownloadedVersionsManager.trackLoaded([makeVersion(7, 2)]);
            undownloadedVersionsManager.syncToolbar();

            expect(document.getElementById('undownloadedViewDownloadBtn').disabled).toBe(true);

            undownloadedVersionsManager.toggleVersion('7:2', true);

            expect(document.getElementById('undownloadedViewDownloadBtn').disabled).toBe(false);
            expect(document.getElementById('undownloadedViewDownloadBtnText').textContent)
                .toBe('Download selected (1)');
        });

        it('select-all covers every loaded version but skips locked ones', () => {
            undownloadedVersionsManager.trackLoaded([
                makeVersion(7, 2),
                makeVersion(8, 3),
                // Generation-only versions cannot be picked.
                makeVersion(9, 4, { usageControl: 'Generation' }),
            ]);

            undownloadedVersionsManager.toggleSelectAll(true);

            expect(undownloadedVersionsManager.selectedCount).toBe(2);
            expect(undownloadedVersionsManager.isSelected('9:4')).toBe(false);
            // Both downloadable entries are picked, so the box is checked even
            // though a locked entry was skipped.
            expect(document.getElementById('undownloadedViewSelectAll').checked).toBe(true);
            expect(document.getElementById('undownloadedViewSelectAll').indeterminate).toBe(false);

            undownloadedVersionsManager.toggleSelectAll(false);

            expect(undownloadedVersionsManager.selectedCount).toBe(0);
            expect(document.getElementById('undownloadedViewSelectAll').indeterminate).toBe(false);
        });

        it('marks select-all indeterminate when only some entries are picked', () => {
            undownloadedVersionsManager.trackLoaded([
                makeVersion(7, 2),
                makeVersion(8, 3),
                makeVersion(9, 4, { usageControl: 'Generation' }),
            ]);
            undownloadedVersionsManager.toggleVersion('7:2', true);
            undownloadedVersionsManager.syncToolbar();

            expect(document.getElementById('undownloadedViewSelectAll').checked).toBe(false);
            expect(document.getElementById('undownloadedViewSelectAll').indeterminate).toBe(true);
        });

        it('reports select-all as checked when every downloadable entry is picked', () => {
            undownloadedVersionsManager.trackLoaded([
                makeVersion(7, 2),
                makeVersion(8, 3, { usageControl: 'Generation' }),
            ]);
            undownloadedVersionsManager.toggleSelectAll(true);

            expect(document.getElementById('undownloadedViewSelectAll').checked).toBe(true);
            expect(document.getElementById('undownloadedViewSelectAll').indeterminate).toBe(false);
        });

        it('disables select-all when nothing is loaded', () => {
            undownloadedVersionsManager.syncToolbar();

            expect(document.getElementById('undownloadedViewSelectAll').disabled).toBe(true);
        });
    });

    describe('loaded-set maintenance', () => {
        it('forgets both the entries and their selections on clear', () => {
            undownloadedVersionsManager.trackLoaded([
                makeVersion(7, 2),
                makeVersion(8, 3),
            ]);
            undownloadedVersionsManager.toggleVersion('8:3', true);

            undownloadedVersionsManager.clearLoaded();

            expect(undownloadedVersionsManager.loadedCount).toBe(0);
            expect(undownloadedVersionsManager.selectedCount).toBe(0);
            expect(undownloadedVersionsManager.isSelected('8:3')).toBe(false);
        });

        it('re-tracking an already known version does not duplicate it', () => {
            undownloadedVersionsManager.trackLoaded([makeVersion(7, 2)]);
            undownloadedVersionsManager.trackLoaded([makeVersion(7, 2)]);

            expect(undownloadedVersionsManager.loadedCount).toBe(1);
        });
    });

    describe('downloadability', () => {
        it('treats an unknown usageControl as downloadable', () => {
            expect(undownloadedVersionsManager.isDownloadable(makeVersion(7, 2, { usageControl: null })))
                .toBe(true);
            expect(undownloadedVersionsManager.isDownloadable(makeVersion(7, 2, { usageControl: 'Download' })))
                .toBe(true);
            expect(undownloadedVersionsManager.isDownloadable(makeVersion(7, 2, { usageControl: 'Generation' })))
                .toBe(false);
            expect(undownloadedVersionsManager.isDownloadable(makeVersion(7, 2, { usageControl: 'InternalGeneration' })))
                .toBe(false);
        });
    });

    describe('page binding', () => {
        it('reads the view flag from the bound page state', () => {
            state.pages.loras.undownloadedView = true;
            undownloadedVersionsManager.bind(MODEL_TYPES.LORA);

            expect(undownloadedVersionsManager.isActive(MODEL_TYPES.LORA)).toBe(true);

            state.pages.loras.undownloadedView = false;

            expect(undownloadedVersionsManager.isActive(MODEL_TYPES.LORA)).toBe(false);
        });
    });
});
