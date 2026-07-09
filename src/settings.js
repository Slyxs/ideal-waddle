// ---------------------------------------------------------------------------
// Extension settings: defaults, normalization, helpers
// ---------------------------------------------------------------------------

export const SETTINGS_KEY = 'live2dplus';

export const DEFAULT_MODEL_URL =
    'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/shizuku/shizuku.model.json';

export const MODEL_SOURCES = Object.freeze({
    DEFAULT: 'default',
    URL: 'url',
    LOCAL: 'local',
});

export const DEFAULT_FILTERS = Object.freeze({
    outline: false,
    pixelate: false,
    crt: false,
    noise: false,
    alpha: false,
});

export const DEFAULT_FILTER_PARAMS = Object.freeze({
    outline: { thickness: 2, color: '#805ad5' },
    pixelate: { size: 5 },
    crt: { curvature: 3, lineWidth: 3, lineContrast: 0.2, vignetting: 0.3, vignettingAlpha: 0.8, noise: 0.1 },
    noise: { noise: 0.2 },
    alpha: { alpha: 0.8 },
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    followCursor: true,
    draggable: true,
    enableHitTesting: true,
    modelSource: MODEL_SOURCES.DEFAULT,
    customModelUrl: '',
    localModelPath: '',
    canvasWidth: 900,
    canvasHeight: 900,
    scale: 0.75,
    positionX: 75,
    positionY: 65,
    modelPositionX: 50,
    modelPositionY: 100,
    opacity: 1,
    zIndex: 35,
    reloadKey: 0,
    filters: DEFAULT_FILTERS,
    filterParams: DEFAULT_FILTER_PARAMS,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

function bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

export function normalizeSettings(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const filters = src.filters && typeof src.filters === 'object' ? src.filters : {};
    const fp = src.filterParams && typeof src.filterParams === 'object' ? src.filterParams : {};
    const outline = fp.outline || {};
    const pixelate = fp.pixelate || {};
    const crt = fp.crt || {};
    const noise = fp.noise || {};
    const alpha = fp.alpha || {};

    return {
        enabled: bool(src.enabled, DEFAULT_SETTINGS.enabled),
        followCursor: bool(src.followCursor, DEFAULT_SETTINGS.followCursor),
        draggable: bool(src.draggable, DEFAULT_SETTINGS.draggable),
        enableHitTesting: bool(src.enableHitTesting, DEFAULT_SETTINGS.enableHitTesting),
        modelSource: Object.values(MODEL_SOURCES).includes(src.modelSource)
            ? src.modelSource
            : DEFAULT_SETTINGS.modelSource,
        customModelUrl: typeof src.customModelUrl === 'string' ? src.customModelUrl : '',
        localModelPath: typeof src.localModelPath === 'string' ? src.localModelPath : '',
        canvasWidth: clamp(src.canvasWidth, 100, 3000, DEFAULT_SETTINGS.canvasWidth),
        canvasHeight: clamp(src.canvasHeight, 100, 3000, DEFAULT_SETTINGS.canvasHeight),
        scale: clamp(src.scale, 0.01, 10, DEFAULT_SETTINGS.scale),
        positionX: clamp(src.positionX, 0, 100, DEFAULT_SETTINGS.positionX),
        positionY: clamp(src.positionY, 0, 100, DEFAULT_SETTINGS.positionY),
        modelPositionX: clamp(src.modelPositionX, 0, 100, DEFAULT_SETTINGS.modelPositionX),
        modelPositionY: clamp(src.modelPositionY, 0, 100, DEFAULT_SETTINGS.modelPositionY),
        opacity: clamp(src.opacity, 0, 1, DEFAULT_SETTINGS.opacity),
        zIndex: clamp(src.zIndex, 0, 9999, DEFAULT_SETTINGS.zIndex),
        reloadKey: Number.isInteger(src.reloadKey) ? src.reloadKey : 0,
        filters: {
            outline: bool(filters.outline, false),
            pixelate: bool(filters.pixelate, false),
            crt: bool(filters.crt, false),
            noise: bool(filters.noise, false),
            alpha: bool(filters.alpha, false),
        },
        filterParams: {
            outline: {
                thickness: clamp(outline.thickness, 0, 20, 2),
                color: typeof outline.color === 'string' ? outline.color : '#805ad5',
            },
            pixelate: {
                size: clamp(pixelate.size, 1, 50, 5),
            },
            crt: {
                curvature: clamp(crt.curvature, 0, 10, 3),
                lineWidth: clamp(crt.lineWidth, 0, 10, 3),
                lineContrast: clamp(crt.lineContrast, 0, 1, 0.2),
                vignetting: clamp(crt.vignetting, 0, 1, 0.3),
                vignettingAlpha: clamp(crt.vignettingAlpha, 0, 1, 0.8),
                noise: clamp(crt.noise, 0, 1, 0.1),
            },
            noise: {
                noise: clamp(noise.noise, 0, 1, 0.2),
            },
            alpha: {
                alpha: clamp(alpha.alpha, 0, 1, 0.8),
            },
        },
    };
}

export function resolveModelUrl(settings) {
    switch (settings.modelSource) {
        case MODEL_SOURCES.URL:
            return settings.customModelUrl.trim() || null;
        case MODEL_SOURCES.LOCAL:
            return settings.localModelPath.trim() || null;
        case MODEL_SOURCES.DEFAULT:
        default:
            return DEFAULT_MODEL_URL;
    }
}
