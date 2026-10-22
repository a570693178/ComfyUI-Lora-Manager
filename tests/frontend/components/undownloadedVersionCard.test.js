import { describe, it, beforeEach, expect, vi } from 'vitest';

const {
    CARD_MODULE,
    MANAGER_MODULE,
    I18N_MODULE,
    CONSTANTS_MODULE,
    MODEL_API_FACTORY_MODULE,
    API_CONFIG_MODULE,
    STATE_MODULE,
    UI_HELPERS_MODULE,
} = vi.hoisted(() => ({
    CARD_MODULE: new URL('../../../static/js/components/shared/UndownloadedVersionCard.js', import.meta.url).pathname,
    MANAGER_MODULE: new URL('../../../static/js/managers/UndownloadedVersionsManager.js', import.meta.url).pathname,
    I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
    CONSTANTS_MODULE: new URL('../../../static/js/utils/constants.js', import.meta.url).pathname,
    MODEL_API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
    API_CONFIG_MODULE: new URL('../../../static/js/api/apiConfig.js', import.meta.url).pathname,
    STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
    UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
}));

vi.mock(I18N_MODULE, () => ({ translate: (key, _args, fallback) => fallback || key }));
vi.mock(MODEL_API_FACTORY_MODULE, () => ({ getModelApiClient: vi.fn() }));
vi.mock(UI_HELPERS_MODULE, () => ({ showToast: vi.fn() }));
vi.mock(API_CONFIG_MODULE, () => ({
    MODEL_TYPES: { LORA: 'loras', CHECKPOINT: 'checkpoints', EMBEDDING: 'embeddings', OTHER: 'other' },
}));
// Only the base-model abbreviation is overridden; the rest of the module is
// real because state/index.js reads DEFAULT_PRIORITY_TAG_CONFIG from it.
vi.mock(CONSTANTS_MODULE, async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, getBaseModelAbbreviation: (value) => value };
});

const { createUndownloadedVersionCard } = await import(CARD_MODULE);
const { undownloadedVersionsManager } = await import(MANAGER_MODULE);
const { state } = await import(STATE_MODULE);

function makeVersion(overrides = {}) {
    return {
        modelId: 7,
        modelName: 'Alpha Model',
        versionId: 3419173,
        versionName: 'MOSS-Image',
        baseModel: 'MOSS Image',
        previewUrl: 'https://example.com/preview.jpeg',
        isEarlyAccess: false,
        isPaid: false,
        usageControl: 'Download',
        releasedAt: null,
        ...overrides,
    };
}

describe('createUndownloadedVersionCard', () => {
    beforeEach(() => {
        // Drop the previous test's cards first: a detached card keeps its
        // listeners, and a stale card for the same key would answer the click.
        document.body.innerHTML = '';
        undownloadedVersionsManager.clearLoaded();
        // A test that switches the Civitai host must not leak it into the
        // next one.
        state.global.settings.civitai_host = 'civitai.com';
    });

    it('renders as a model card so the grid styling is shared', () => {
        const card = createUndownloadedVersionCard(makeVersion());

        expect(card.classList.contains('model-card')).toBe(true);
        expect(card.classList.contains('undownloaded-version-card')).toBe(true);
        // Not draggable: there is no local file to move.
        expect(card.draggable).toBe(false);
    });

    it('shows the model name and the version name', () => {
        const card = createUndownloadedVersionCard(makeVersion());

        expect(card.querySelector('.model-name').textContent).toBe('Alpha Model');
        expect(card.querySelector('.version-name').textContent).toBe('MOSS-Image');
    });

    it('falls back to the version id when the version has no name', () => {
        const card = createUndownloadedVersionCard(makeVersion({ versionName: '' }));

        expect(card.querySelector('.version-name').textContent).toBe('#3419173');
    });

    it('uses the no-preview placeholder when there is no image', () => {
        const card = createUndownloadedVersionCard(makeVersion({ previewUrl: null }));

        expect(card.querySelector('img').getAttribute('src'))
            .toBe('/loras_static/images/no-preview.png');
    });

    it('exposes a checkbox carrying the version key', () => {
        const card = createUndownloadedVersionCard(makeVersion());
        const checkbox = card.querySelector('.undownloaded-version-checkbox');

        expect(checkbox).not.toBeNull();
        expect(checkbox.dataset.versionKey).toBe('7:3419173');
        expect(checkbox.disabled).toBe(false);
    });

    it('disables the checkbox for versions CivitAI will not serve', () => {
        const card = createUndownloadedVersionCard(
            makeVersion({ usageControl: 'Generation' })
        );

        expect(card.querySelector('.undownloaded-version-checkbox').disabled).toBe(true);
        expect(card.classList.contains('is-locked')).toBe(true);
        expect(card.querySelector('.undownloaded-version-badge.is-locked')).not.toBeNull();
    });

    it('reflects an already-selected version', () => {
        undownloadedVersionsManager.toggleVersion('7:3419173', true);
        const card = createUndownloadedVersionCard(makeVersion());

        expect(card.classList.contains('is-selected')).toBe(true);
        expect(card.querySelector('.undownloaded-version-checkbox').checked).toBe(true);
    });

    it('shows early-access and paid badges when flagged', () => {
        const card = createUndownloadedVersionCard(
            makeVersion({ isEarlyAccess: true, isPaid: true })
        );

        expect(card.querySelector('.undownloaded-version-badge.is-early-access')).not.toBeNull();
        expect(card.querySelector('.undownloaded-version-badge.is-paid')).not.toBeNull();
    });

    it('toggles the selection when the checkbox changes', () => {
        const card = createUndownloadedVersionCard(makeVersion());
        const checkbox = card.querySelector('.undownloaded-version-checkbox');

        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        expect(undownloadedVersionsManager.isSelected('7:3419173')).toBe(true);

        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        expect(undownloadedVersionsManager.isSelected('7:3419173')).toBe(false);
    });

    it('toggles the selection when the card body is clicked', () => {
        const card = createUndownloadedVersionCard(makeVersion());
        document.body.appendChild(card);

        card.click();

        expect(undownloadedVersionsManager.isSelected('7:3419173')).toBe(true);
    });

    it('clicking the label selects exactly once, not twice', () => {
        const card = createUndownloadedVersionCard(makeVersion());
        document.body.appendChild(card);
        const label = card.querySelector('.undownloaded-version-select');

        // jsdom forwards a label click to the wrapped input, so both a label
        // and an input click reach the card. The card-body handler must ignore
        // them, otherwise the single user click would toggle twice and cancel
        // itself out.
        label.click();

        expect(undownloadedVersionsManager.selectedCount).toBe(1);
        expect(undownloadedVersionsManager.isSelected('7:3419173')).toBe(true);
    });

    it('does not double-toggle when the checkbox itself is clicked', () => {
        const card = createUndownloadedVersionCard(makeVersion());
        document.body.appendChild(card);
        const checkbox = card.querySelector('.undownloaded-version-checkbox');

        checkbox.click();

        expect(undownloadedVersionsManager.selectedCount).toBe(1);
    });

    it('does not select a locked version on click', () => {
        const card = createUndownloadedVersionCard(
            makeVersion({ usageControl: 'InternalGeneration' })
        );
        document.body.appendChild(card);

        card.click();

        expect(undownloadedVersionsManager.selectedCount).toBe(0);
    });

    it('escapes HTML in names so a crafted model name cannot inject markup', () => {
        const card = createUndownloadedVersionCard(
            makeVersion({ modelName: '<img src=x onerror=alert(1)>' })
        );

        // The name is rendered as text, so the payload stays inert.
        expect(card.querySelector('.model-name').innerHTML)
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(card.querySelector('.model-name').querySelector('img')).toBeNull();
        // The only real image is the preview, whose own onerror fallback is
        // part of the card template.
        expect(card.querySelectorAll('img').length).toBe(1);
    });

    describe('Civitai link', () => {
        it('links to the version page and opens it in a new tab', () => {
            const card = createUndownloadedVersionCard(makeVersion());
            const link = card.querySelector('.undownloaded-version-civitai-link');

            expect(link).not.toBeNull();
            expect(link.getAttribute('href'))
                .toBe('https://civitai.com/models/7?modelVersionId=3419173');
            expect(link.getAttribute('target')).toBe('_blank');
            expect(link.getAttribute('rel')).toBe('noopener noreferrer');
            expect(link.querySelector('i.fa-arrow-up-right-from-square')).not.toBeNull();
        });

        it('follows the configured Civitai host', () => {
            state.global.settings.civitai_host = 'civitai.red';

            const card = createUndownloadedVersionCard(makeVersion());
            const link = card.querySelector('.undownloaded-version-civitai-link');

            expect(link.getAttribute('href'))
                .toBe('https://civitai.red/models/7?modelVersionId=3419173');
        });

        it('does not toggle the selection when the link is clicked', () => {
            const card = createUndownloadedVersionCard(makeVersion());
            document.body.appendChild(card);

            card.querySelector('.undownloaded-version-civitai-link').click();

            expect(undownloadedVersionsManager.selectedCount).toBe(0);
        });
    });

    describe('preview media', () => {
        it('renders a still image for a normal preview', () => {
            const card = createUndownloadedVersionCard(makeVersion());

            expect(card.querySelector('.card-preview img')).not.toBeNull();
            expect(card.querySelector('.card-preview video')).toBeNull();
        });

        it('renders a video element for an mp4 preview', () => {
            const card = createUndownloadedVersionCard(
                makeVersion({ previewUrl: 'https://image.civitai.com/clip.mp4' })
            );

            const video = card.querySelector('.card-preview video');
            expect(video).not.toBeNull();
            expect(video.getAttribute('src')).toBe('https://image.civitai.com/clip.mp4');
            // An <img> cannot decode a clip, so it must not be rendered too.
            expect(card.querySelector('.card-preview img')).toBeNull();
        });

        it('renders a video element for a webm preview', () => {
            const card = createUndownloadedVersionCard(
                makeVersion({ previewUrl: 'https://image.civitai.com/clip.webm' })
            );

            expect(card.querySelector('.card-preview video')).not.toBeNull();
        });

        it('keeps an animated gif as an image', () => {
            const card = createUndownloadedVersionCard(
                makeVersion({ previewUrl: 'https://image.civitai.com/clip.gif' })
            );

            expect(card.querySelector('.card-preview img')).not.toBeNull();
            expect(card.querySelector('.card-preview video')).toBeNull();
        });

        it('detects a real CivitAI video url with transcode parameters', () => {
            // The real url embeds the rendition options in the path, so the
            // extension only shows up at the very end of a long string.
            const card = createUndownloadedVersionCard(makeVersion({
                previewUrl: 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/'
                    + '3ff28ee1-3c79-4d00-8a6b-4c1036e86809/'
                    + 'transcode=true,width=450,optimized=true/129184406.mp4',
            }));

            expect(card.querySelector('.card-preview video')).not.toBeNull();
            expect(card.querySelector('.card-preview img')).toBeNull();
        });
    });
});
