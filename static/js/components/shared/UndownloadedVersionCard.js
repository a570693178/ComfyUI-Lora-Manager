import { translate } from '../../utils/i18nHelpers.js';
import { getBaseModelAbbreviation } from '../../utils/constants.js';
import { undownloadedVersionsManager } from '../../managers/UndownloadedVersionsManager.js';
import { isVideoUrl } from '../../utils/mediaUtils.js';
import { buildCivitaiModelUrl } from '../../utils/civitaiUtils.js';
import { state } from '../../state/index.js';

/**
 * Card for one remote version that is not in the local library yet.
 *
 * The markup deliberately mirrors `.model-card` (same preview / header /
 * footer skeleton and the same CSS classes) so the pending list reads as the
 * same grid as /loras instead of a separate list widget. The differences are
 * the parts a remote version actually has: a selection checkbox instead of
 * the local-model action icons, a "view on CivitAI" link to the version page,
 * and status badges for early-access / paid / non-downloadable versions.
 *
 * @param {Object} version - one entry of the undownloaded-versions payload
 * @returns {HTMLElement}
 */
export function createUndownloadedVersionCard(version) {
    const card = document.createElement('div');
    card.className = 'model-card undownloaded-version-card';
    card.draggable = false;

    const key = `${version.modelId}:${version.versionId}`;
    card.dataset.versionKey = key;
    card.dataset.modelId = String(version.modelId ?? '');
    card.dataset.versionId = String(version.versionId ?? '');
    card.dataset.base_model = version.baseModel || 'Unknown';

    const checked = undownloadedVersionsManager.isSelected(key);
    const downloadable = undownloadedVersionsManager.isDownloadable(version);
    if (checked) {
        card.classList.add('is-selected');
    }
    if (!downloadable) {
        card.classList.add('is-locked');
    }

    const previewUrl = version.previewUrl || '/loras_static/images/no-preview.png';
    const versionLabel = version.versionName || `#${version.versionId}`;
    const modelName = version.modelName || '';
    const baseModelLabel = version.baseModel || 'Unknown';
    const baseModelAbbreviation = getBaseModelAbbreviation(baseModelLabel);

    // A remote version can preview as a still image, an animated GIF or a
    // video clip. A <video> element is the only way the clip renders; an
    // <img> would fail to decode it and fall back to the placeholder.
    const isVideo = isVideoUrl(previewUrl);
    const previewMarkup = isVideo
        ? `<video src="${escapeAttr(previewUrl)}" controls muted loop playsinline
                  preload="metadata" style="pointer-events: none;"></video>`
        : `<img draggable="false" src="${escapeAttr(previewUrl)}" alt="${escapeAttr(modelName)}"
                 onerror="this.onerror=null; this.src='/loras_static/images/no-preview.png'">`;

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

    const selectTitle = translate(
        'modals.undownloadedVersions.selectOne',
        {},
        'Select this version'
    );

    // "View on CivitAI" opens the version page in a new tab, the same way the
    // globe icon does on a local model card.
    const civitaiUrl = buildCivitaiModelUrl(
        version.modelId,
        version.versionId,
        state?.global?.settings?.civitai_host
    );
    const civitaiTitle = translate(
        'modals.model.versions.actions.viewVersionOnCivitai',
        {},
        'View version on CivitAI'
    );
    const civitaiLinkMarkup = civitaiUrl
        ? `<a class="undownloaded-version-civitai-link"
                  href="${escapeAttr(civitaiUrl)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  title="${escapeAttr(civitaiTitle)}"
                  aria-label="${escapeAttr(civitaiTitle)}">
               <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>
           </a>`
        : '';

    card.innerHTML = `
        <div class="card-preview">
            ${previewMarkup}
            <div class="card-header">
                <div class="card-header-info">
                    <span class="base-model-label" title="${escapeAttr(baseModelLabel)}">
                        <span class="model-base-type">${escapeHtml(baseModelAbbreviation)}</span>
                    </span>
                    ${badges.length ? `<span class="undownloaded-version-badges">${badges.join('')}</span>` : ''}
                </div>
                <div class="undownloaded-version-tools">
                    ${civitaiLinkMarkup}
                    <label class="undownloaded-version-select" title="${escapeAttr(selectTitle)}">
                        <input type="checkbox" class="undownloaded-version-checkbox"
                               data-version-key="${escapeAttr(key)}"
                               ${checked ? 'checked' : ''} ${downloadable ? '' : 'disabled'}>
                    </label>
                </div>
            </div>
            <div class="card-footer">
                <div class="model-info">
                    <span class="model-name" title="${escapeAttr(modelName)}">${escapeHtml(modelName)}</span>
                    <div class="version-row">
                        <span class="version-name civitai-version">${escapeHtml(versionLabel)}</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    const checkbox = card.querySelector('.undownloaded-version-checkbox');
    checkbox.addEventListener('change', (event) => {
        event.stopPropagation();
        undownloadedVersionsManager.toggleVersion(key, event.target.checked);
    });

    // Clicking the card body toggles selection too, matching how bulk mode
    // treats a card click. Locked versions stay inert, and the CivitAI link
    // keeps its own behaviour instead of selecting the version.
    card.addEventListener('click', (event) => {
        if (event.target.closest('.undownloaded-version-select')) return;
        if (event.target.closest('.undownloaded-version-civitai-link')) return;
        if (!downloadable) return;
        undownloadedVersionsManager.toggleVersion(key, !checked);
    });

    return card;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
}
