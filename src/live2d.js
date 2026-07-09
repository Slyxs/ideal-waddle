// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

// Local lib scripts — same files used by Dustpan, served from this extension's lib/ folder.
// pixi-live2d-display-lipsyncpatch-0.5.0-ls-8 supports PixiJS 7; the old CDN
// cubism2.min.js (v0.4.0) only supports PixiJS 6 and is incompatible.
const EXTENSION_PATH = 'scripts/extensions/third-party/Extension-Live2D+';

const LIVE2D_RUNTIME_SCRIPTS = [
    `${EXTENSION_PATH}/lib/TweenLite-1.20.2.js`,
    `${EXTENSION_PATH}/lib/live2d.min.js`,
    `${EXTENSION_PATH}/lib/live2dcubismcore.min.js`,
    `${EXTENSION_PATH}/lib/pixi-7.4.2.min.js`,
    `${EXTENSION_PATH}/lib/pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js`,
    `${EXTENSION_PATH}/lib/pixi-filters.min.js`,
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
        el.async = true;
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
            for (const src of LIVE2D_RUNTIME_SCRIPTS) {
                await loadScript(src);
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
