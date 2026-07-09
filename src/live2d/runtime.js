// ─────────────────────────────────────────────────────────────────────────────
// Live2D runtime script loading
//
// Scripts are loaded once and cached.  The attribute used as a cache key is
// scoped to this extension so it never collides with other loaders on the page.
//
// CDN order matters: CubismCore must come before pixi-live2d-display, and
// pixi.js must come before both.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_ATTR = 'data-live2d-tts-src';

// To use local copies instead of CDN, place the files under
//   SillyTavern/public/scripts/extensions/third-party/<folder>/lib/
// and change these URLs to relative paths like /scripts/extensions/…/lib/pixi.min.js
const RUNTIME_SCRIPTS = [
    'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    'https://cdn.jsdelivr.net/npm/pixi.js@7/dist/pixi.min.js',
    'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/index.min.js',
    'https://cdn.jsdelivr.net/npm/pixi-filters@5/dist/pixi-filters.js',
];

let runtimeLoadPromise = null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadScriptOnce(src) {
    const existing = document.querySelector(`script[${SCRIPT_ATTR}="${src}"]`);
    if (existing) {
        if (existing.dataset.loaded === 'true') return Promise.resolve();
        return new Promise((resolve, reject) => {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
        });
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.setAttribute(SCRIPT_ATTR, src);
        script.addEventListener('load', () => {
            script.dataset.loaded = 'true';
            resolve();
        }, { once: true });
        script.addEventListener('error', () =>
            reject(new Error(`[Live2D TTS] Failed to load script: ${src}`)),
        { once: true });
        document.head.appendChild(script);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// loadLive2DRuntime — loads all scripts in order, returns { PIXI, Live2DModel }
// ─────────────────────────────────────────────────────────────────────────────

export async function loadLive2DRuntime() {
    if (!runtimeLoadPromise) {
        runtimeLoadPromise = (async () => {
            for (const src of RUNTIME_SCRIPTS) {
                await loadScriptOnce(src);
            }
        })();
    }

    try {
        await runtimeLoadPromise;
    } catch (err) {
        runtimeLoadPromise = null; // allow retry on next call
        throw err;
    }

    const PIXI = window.PIXI;
    const Live2DModel = PIXI?.live2d?.Live2DModel;

    if (!PIXI || !Live2DModel) {
        runtimeLoadPromise = null;
        throw new Error('[Live2D TTS] Runtime initialized but PIXI.live2d.Live2DModel is missing.');
    }

    return { PIXI, Live2DModel };
}

// ─────────────────────────────────────────────────────────────────────────────
// hexToNumber — '#805ad5' → 0x805ad5
// ─────────────────────────────────────────────────────────────────────────────

export function hexToNumber(hex) {
    const normalized = typeof hex === 'string' ? hex.replace('#', '') : '';
    const parsed = Number.parseInt(normalized, 16);
    return Number.isFinite(parsed) ? parsed : 0x805ad5;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFilters — creates PIXI filter instances from settings
// ─────────────────────────────────────────────────────────────────────────────

export function buildFilters(settings, PIXI) {
    const filters = [];
    const { filters: enabled, filterParams: params } = settings;
    const pf = PIXI?.filters ?? {};

    if (enabled.outline && pf.OutlineFilter) {
        filters.push(new pf.OutlineFilter(
            params.outline.thickness,
            hexToNumber(params.outline.color),
        ));
    }

    if (enabled.pixelate && pf.PixelateFilter) {
        filters.push(new pf.PixelateFilter(params.pixelate.size));
    }

    if (enabled.crt && pf.CRTFilter) {
        filters.push(new pf.CRTFilter({
            curvature:       params.crt.curvature,
            lineWidth:       params.crt.lineWidth,
            lineContrast:    params.crt.lineContrast,
            vignetting:      params.crt.vignetting,
            vignettingAlpha: params.crt.vignettingAlpha,
            noise:           params.crt.noise,
            seed:            Math.random(),
        }));
    }

    if (enabled.noise && (pf.NoiseFilter ?? PIXI.filters?.NoiseFilter)) {
        const NoiseFilter = pf.NoiseFilter ?? PIXI.filters.NoiseFilter;
        filters.push(new NoiseFilter(params.noise.noise));
    }

    if (enabled.alpha && (pf.AlphaFilter ?? PIXI.filters?.AlphaFilter)) {
        const AlphaFilter = pf.AlphaFilter ?? PIXI.filters.AlphaFilter;
        filters.push(new AlphaFilter(params.alpha.alpha));
    }

    return filters;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyModelTransform — sets scale, position, and anchor from settings
// ─────────────────────────────────────────────────────────────────────────────

export function applyModelTransform(model, settings) {
    if (!model) return;
    model.scale.set(settings.scale);
    model.x = (settings.canvasWidth  * settings.modelPositionX) / 100;
    model.y = (settings.canvasHeight * settings.modelPositionY) / 100;
    if (model.anchor?.set) {
        model.anchor.set(settings.anchorX, settings.anchorY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// readModelMotions — returns { groupName: [label, ...] } from a loaded model
// ─────────────────────────────────────────────────────────────────────────────

export function readModelMotions(model) {
    const definitions =
        model?.internalModel?.settings?.motions ??
        model?.internalModel?.motionManager?.definitions ??
        {};

    const result = {};
    for (const [group, motions] of Object.entries(definitions)) {
        if (!Array.isArray(motions) || motions.length === 0) continue;
        result[group] = motions.map((motion, index) => {
            const raw = typeof motion === 'string'
                ? motion
                : motion?.File ?? motion?.file ?? motion?.name ?? motion?.Name ?? `Motion ${index + 1}`;
            return String(raw).replace(/\.(mtn|motion3?|json)$/i, '');
        });
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// readModelExpressions — returns [label, ...] from a loaded model
// ─────────────────────────────────────────────────────────────────────────────

export function readModelExpressions(model) {
    const source =
        model?.internalModel?.settings?.expressions ??
        model?.internalModel?.motionManager?.expressionManager?.definitions ??
        [];

    const list = Array.isArray(source)
        ? source
        : (source && typeof source === 'object' ? Object.values(source) : []);

    return list.filter(Boolean).map((expression, index) => {
        if (typeof expression === 'string') return expression.replace(/\.(exp3?|json)$/i, '');
        return expression?.name ?? expression?.Name ?? expression?.File ?? expression?.file ?? `Expression ${index}`;
    });
}
