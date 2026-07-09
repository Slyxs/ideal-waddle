// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

// CDN-hosted scripts — loaded in order (each script may depend on the prior)
const LIVE2D_CDN_SCRIPTS = [
    // GSAP TweenLite — required by the Cubism 2 SDK
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/1.20.2/TweenLite.min.js',
    // Live2D Cubism 2 SDK (.moc models)
    'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js',
    // Live2D Cubism 4 Core (.moc3 models)
    'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    // PixiJS v7
    'https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js',
    // pixi-live2d-display — attaches as PIXI.live2d, must load after PIXI
    'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.5.0/dist/index.min.js',
    // PIXI filters (Outline, Pixelate, CRT, etc.)
    'https://cdn.jsdelivr.net/npm/pixi-filters@5.0.0/dist/pixi-filters.min.js',
];

const SCRIPT_ATTR = 'data-live2dplus-src';

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
            for (const src of LIVE2D_CDN_SCRIPTS) {
                await loadScript(src);
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
