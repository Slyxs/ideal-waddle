// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

// Runtime scripts loaded from this extension's served folder.
// SillyTavern mounts third-party extensions at /scripts/extensions/third-party/<folder>.
const EXTENSION_FOLDER = 'Extension-Live2D+';
const EXTENSION_WEB_PATH = `/scripts/extensions/third-party/${encodeURIComponent(EXTENSION_FOLDER)}`;

const LIVE2D_RUNTIME_FILES = [
    'TweenLite-1.20.2.js',
    'live2d.min.js',
    'live2dcubismcore.min.js',
    'pixi-7.4.2.min.js',
    'pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js',
    'pixi-filters.min.js',
];

const LIVE2D_RUNTIME_SCRIPTS = LIVE2D_RUNTIME_FILES.map((file) => `${EXTENSION_WEB_PATH}/lib/${file}`);

const SCRIPT_ATTR = 'data-live2dplus-src';

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

function findScript(src) {
    return document.querySelector(`script[${SCRIPT_ATTR}="${src}"]`);
}

function appendScript(src, key = src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = true;
        el.type = 'text/javascript';
        el.setAttribute(SCRIPT_ATTR, key);
        el.addEventListener('load', () => {
            el.dataset.loaded = 'true';
            resolve();
        }, { once: true });
        el.addEventListener('error', () => {
            el.dataset.failed = 'true';
            reject(new Error(`Failed to load: ${key}`));
        }, { once: true });
        document.head.appendChild(el);
    });
}

async function loadScriptFromBlob(src) {
    const response = await fetch(src, { credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || 'unknown content type';

    if (!response.ok) {
        throw new Error(`Failed to fetch ${src}: HTTP ${response.status} ${response.statusText || ''} (${contentType})`.trim());
    }

    const source = await response.text();
    if (!source.trim()) {
        throw new Error(`Failed to load ${src}: response was empty (${contentType})`);
    }

    const blob = new Blob([`${source}\n//# sourceURL=${src}`], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);

    try {
        await appendScript(blobUrl, src);
    } catch (blobError) {
        throw new Error(`Failed to execute ${src} from Blob: ${blobError.message}`);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

async function loadScript(src) {
    if (typeof document === 'undefined') return Promise.resolve();

    const existing = findScript(src);
    if (existing) {
        if (existing.dataset.loaded === 'true') return Promise.resolve();
        if (existing.dataset.failed === 'true') existing.remove();
        else {
            return new Promise((resolve, reject) => {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', () => reject(new Error(`Failed: ${src}`)), { once: true });
            });
        }
    }

    try {
        await loadScriptFromBlob(src);
    } catch (blobError) {
        findScript(src)?.remove();
        try {
            await appendScript(src);
        } catch (scriptError) {
            throw new Error(`${blobError.message}; script tag fallback also failed: ${scriptError.message}`);
        }
    }
}

let _runtimePromise = null;

export async function loadLive2DRuntime() {
    if (!_runtimePromise) {
        _runtimePromise = (async () => {
            for (const src of LIVE2D_RUNTIME_SCRIPTS) {
                await loadScript(src);
            }

            if (!window.Live2DCubismCore) {
                throw new Error(`Cubism 4 core failed to load from ${EXTENSION_WEB_PATH}/lib/live2dcubismcore.min.js`);
            }

            // Mute motion/expression audio (models can bundle sound clips in their motions).
            // We silence the sound manager globally so models don't play unexpected noises.
            // The lipsync speak() path uses its own audio element and is unaffected.
            const live2d = window.PIXI?.live2d;
            if (live2d?.SoundManager) {
                live2d.SoundManager.volume = 0;
            }
        })();
    }

    await _runtimePromise;

    const PIXI = window.PIXI;
    const Live2DModel = PIXI?.live2d?.Live2DModel;

    if (!PIXI || !Live2DModel) {
        throw new Error('Live2D runtime failed to initialize (PIXI or Live2DModel missing).');
    }

    return { PIXI, Live2DModel };
}

// ---------------------------------------------------------------------------
// Filter building
// ---------------------------------------------------------------------------

function hexToNumber(hex) {
    const s = typeof hex === 'string' ? hex.replace('#', '') : '';
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : 0x805ad5;
}

export function buildFilters(settings, PIXI) {
    const filters = [];
    const enabled = settings.filters || {};
    const p = settings.filterParams || {};

    if (enabled.outline) {
        const F = PIXI?.filters?.OutlineFilter;
        if (F) filters.push(new F(p.outline?.thickness ?? 2, hexToNumber(p.outline?.color)));
    }
    if (enabled.pixelate) {
        const F = PIXI?.filters?.PixelateFilter;
        if (F) filters.push(new F(p.pixelate?.size ?? 5));
    }
    if (enabled.crt) {
        const F = PIXI?.filters?.CRTFilter;
        if (F) filters.push(new F({
            curvature: p.crt?.curvature ?? 3,
            lineWidth: p.crt?.lineWidth ?? 3,
            lineContrast: p.crt?.lineContrast ?? 0.2,
            vignetting: p.crt?.vignetting ?? 0.3,
            vignettingAlpha: p.crt?.vignettingAlpha ?? 0.8,
            noise: p.crt?.noise ?? 0.1,
            seed: Math.random(),
        }));
    }
    if (enabled.noise) {
        const F = PIXI?.filters?.NoiseFilter;
        if (F) filters.push(new F(p.noise?.noise ?? 0.2));
    }
    if (enabled.alpha) {
        const F = PIXI?.filters?.AlphaFilter;
        if (F) filters.push(new F(p.alpha?.alpha ?? 0.8));
    }

    return filters;
}

// ---------------------------------------------------------------------------
// Model interaction
// ---------------------------------------------------------------------------

export function applyModelInteraction(model, settings) {
    if (!model) return;

    const autoFocus = !!settings.followCursor;
    const autoHitTest = !!settings.enableHitTesting;
    const interactive = autoFocus || autoHitTest;

    if (model.automator) {
        model.automator.autoFocus = autoFocus;
        model.automator.autoHitTest = autoHitTest;
    } else {
        if ('autoFocus' in model) model.autoFocus = autoFocus;
        if ('autoHitTest' in model) model.autoHitTest = autoHitTest;
        if ('autoInteract' in model) model.autoInteract = interactive;
    }

    model.eventMode = interactive ? 'static' : 'none';
    model.interactive = interactive;

    if (!autoFocus) {
        model.internalModel?.focusController?.focus?.(0, 0, true);
    }
}

// ---------------------------------------------------------------------------
// Model transform
// ---------------------------------------------------------------------------

export function applyModelTransform(model, settings) {
    if (!model) return;
    model.scale.set(settings.scale);
    model.x = (settings.canvasWidth * settings.modelPositionX) / 100;
    model.y = (settings.canvasHeight * settings.modelPositionY) / 100;
    if (model.anchor?.set) {
        model.anchor.set(0.5, 0.5);
    }
}
