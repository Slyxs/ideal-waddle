// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

const EXTENSION_LIBS = [
    'TweenLite-1.20.2.js',
    'live2d.min.js',
    'live2dcubismcore.min.js',
    'pixi-7.4.2.min.js',
    'pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js',
    'pixi-filters.min.js',
];

const SCRIPT_ATTR = 'data-live2dplus-src';

// ---------------------------------------------------------------------------
// Resolve the extension's lib directory URL at runtime
// ---------------------------------------------------------------------------

function getExtensionLibBase() {
    if (typeof document === 'undefined') {
        return '/scripts/extensions/third-party/Extension-Live2D+/lib';
    }
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    for (const script of scripts) {
        if (script.src.includes('Extension-Live2D+')) {
            return script.src.replace(/\/dist\/[^/]+(\?.*)?$/, '/lib');
        }
    }
    return '/scripts/extensions/third-party/Extension-Live2D+/lib';
}

let _libBase = null;
function libBase() {
    if (!_libBase) _libBase = getExtensionLibBase();
    return _libBase;
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

function loadScript(src) {
    if (typeof document === 'undefined') return Promise.resolve();

    const existing = document.querySelector(`script[${SCRIPT_ATTR}="${src}"]`);
    if (existing) {
        if (existing.dataset.loaded === 'true') return Promise.resolve();
        return new Promise((resolve, reject) => {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed: ${src}`)), { once: true });
        });
    }

    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = false;
        el.setAttribute(SCRIPT_ATTR, src);
        el.addEventListener('load', () => {
            el.dataset.loaded = 'true';
            resolve();
        }, { once: true });
        el.addEventListener('error', () => reject(new Error(`Failed to load: ${src}`)), { once: true });
        document.head.appendChild(el);
    });
}

let _runtimePromise = null;

export async function loadLive2DRuntime() {
    if (!_runtimePromise) {
        _runtimePromise = (async () => {
            const base = libBase();
            for (const lib of EXTENSION_LIBS) {
                await loadScript(`${base}/${lib}`);
            }
        })();
    }

    await _runtimePromise;

    const PIXI = window.PIXI;
    const Live2DModel = PIXI?.live2d?.Live2DModel;

    if (!PIXI || !Live2DModel) {
        // Reset so caller can retry
        _runtimePromise = null;
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
