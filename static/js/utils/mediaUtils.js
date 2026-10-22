// mediaUtils.js — tell preview media apart by its URL.
//
// A CivitAI version can ship a still image, an animated GIF or a short video
// clip, and the API hands all three over as a plain URL. The file extension
// is the only signal the frontend has, so the detection lives in one shared
// place instead of being re-implemented per card — the version list and the
// pending-version grid must agree on what counts as a video.

export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv'];

/**
 * Extract the file extension of a URL-ish string.
 *
 * The value is inspected as-is and split on query separators, so a URL whose
 * extension only appears in a query parameter is still recognised.
 *
 * @param {*} value
 * @returns {string} the lower-cased extension including the dot, or '' when
 *                   the value carries none.
 */
export function extractExtension(value) {
    if (value == null) {
        return '';
    }
    const targets = [];
    const stringValue = String(value);
    if (stringValue) {
        targets.push(stringValue);
        stringValue.split(/[?&=]/).forEach((fragment) => {
            if (fragment) {
                targets.push(fragment);
            }
        });
    }

    for (const target of targets) {
        let candidate = target;
        try {
            candidate = decodeURIComponent(candidate);
        } catch (error) {
            // ignoring malformed sequences, fallback to raw value
        }
        const lastDot = candidate.lastIndexOf('.');
        if (lastDot === -1) {
            continue;
        }
        const extension = candidate.slice(lastDot).toLowerCase();
        if (extension.includes('/') || extension.includes('\\')) {
            continue;
        }
        return extension;
    }

    return '';
}

/**
 * Whether a preview URL points at a video clip.
 *
 * Animated GIFs are not videos: they play inside an <img> element, so they
 * are deliberately not part of VIDEO_EXTENSIONS.
 *
 * @param {*} url
 * @returns {boolean}
 */
export function isVideoUrl(url) {
    if (!url || typeof url !== 'string') {
        return false;
    }

    const candidates = new Set();
    const addCandidate = (value) => {
        if (value == null) {
            return;
        }
        const stringValue = String(value);
        if (!stringValue) {
            return;
        }
        candidates.add(stringValue);
    };

    addCandidate(url);

    try {
        const parsed = new URL(url, window.location.origin);
        addCandidate(parsed.pathname);
        parsed.searchParams.forEach((value) => addCandidate(value));
    } catch (error) {
        // ignore parse errors and rely on fallbacks below
    }

    for (const candidate of candidates) {
        const extension = extractExtension(candidate);
        if (extension && VIDEO_EXTENSIONS.includes(extension)) {
            return true;
        }
    }

    return false;
}
