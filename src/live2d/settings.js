// ─────────────────────────────────────────────────────────────────────────────
// Model source constants
// ─────────────────────────────────────────────────────────────────────────────

export const MODEL_SOURCE = Object.freeze({
    DEFAULT: 'default',
    URL:     'url',
    LOCAL:   'local',
});

export const MODEL_SOURCE_LABELS = Object.freeze({
    [MODEL_SOURCE.DEFAULT]: 'Default demo model',
    [MODEL_SOURCE.URL]:     'Custom URL',
    [MODEL_SOURCE.LOCAL]:   'Local file path',
});

export const DEFAULT_MODEL_URL =
    'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/shizuku/shizuku.model.json';

// ─────────────────────────────────────────────────────────────────────────────
// Filter defaults
// ─────────────────────────────────────────────────────────────────────────────

export const defaultFilters = Object.freeze({
    outline:  false,
    pixelate: false,
    crt:      false,
    noise:    false,
    alpha:    false,
});

export const defaultFilterParams = Object.freeze({
    outline:  { thickness: 2,   color: '#805ad5' },
    pixelate: { size: 5 },
    crt:      { curvature: 3, lineWidth: 3, lineContrast: 0.2, vignetting: 0.3, vignettingAlpha: 0.8, noise: 0.1 },
    noise:    { noise: 0.2 },
    alpha:    { alpha: 0.8 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Full settings defaults
// ─────────────────────────────────────────────────────────────────────────────

export const defaultSettings = Object.freeze({
    enabled:          false,
    // model source
    modelSource:      MODEL_SOURCE.DEFAULT,
    customUrl:        '',
    localPath:        '',
    // canvas / rendering
    canvasWidth:      800,
    canvasHeight:     800,
    scale:            0.75,
    positionX:        78,
    positionY:        68,
    modelPositionX:   50,
    modelPositionY:   50,
    anchorX:          0.5,
    anchorY:          0.5,
    opacity:          1,
    zIndex:           35,
    // interaction
    draggable:        true,
    followCursor:     true,
    enableHitTesting: true,
    // filters
    filters:          defaultFilters,
    filterParams:     defaultFilterParams,
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
}

function bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function str(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeSettings — coerces any raw object into a valid settings shape
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeSettings(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    const validSources = Object.values(MODEL_SOURCE);

    const rawFilters = (s.filters && typeof s.filters === 'object') ? s.filters : {};
    const rawParams  = (s.filterParams && typeof s.filterParams === 'object') ? s.filterParams : {};
    const rp         = rawParams;

    return {
        enabled:     bool(s.enabled,     false),
        modelSource: validSources.includes(s.modelSource) ? s.modelSource : MODEL_SOURCE.DEFAULT,
        customUrl:   str(s.customUrl,  ''),
        localPath:   str(s.localPath,  ''),

        canvasWidth:    clamp(s.canvasWidth,    100, 2000, 800),
        canvasHeight:   clamp(s.canvasHeight,   100, 2000, 800),
        scale:          clamp(s.scale,          0.01, 10,  0.75),
        positionX:      clamp(s.positionX,      0,   100,  78),
        positionY:      clamp(s.positionY,      0,   100,  68),
        modelPositionX: clamp(s.modelPositionX, 0,   100,  50),
        modelPositionY: clamp(s.modelPositionY, 0,   100,  50),
        anchorX:        clamp(s.anchorX,        0,   1,    0.5),
        anchorY:        clamp(s.anchorY,        0,   1,    0.5),
        opacity:        clamp(s.opacity,        0,   1,    1),
        zIndex:         clamp(s.zIndex,         0,   9999, 35),

        draggable:        bool(s.draggable,        true),
        followCursor:     bool(s.followCursor,     true),
        enableHitTesting: bool(s.enableHitTesting, true),

        filters: {
            outline:  bool(rawFilters.outline,  false),
            pixelate: bool(rawFilters.pixelate, false),
            crt:      bool(rawFilters.crt,      false),
            noise:    bool(rawFilters.noise,    false),
            alpha:    bool(rawFilters.alpha,    false),
        },
        filterParams: {
            outline: {
                thickness: clamp(rp.outline?.thickness, 0, 20, 2),
                color:     str(rp.outline?.color, '#805ad5'),
            },
            pixelate: {
                size: clamp(rp.pixelate?.size, 1, 100, 5),
            },
            crt: {
                curvature:      clamp(rp.crt?.curvature,      0, 20, 3),
                lineWidth:      clamp(rp.crt?.lineWidth,      0, 20, 3),
                lineContrast:   clamp(rp.crt?.lineContrast,   0, 1,  0.2),
                vignetting:     clamp(rp.crt?.vignetting,     0, 1,  0.3),
                vignettingAlpha:clamp(rp.crt?.vignettingAlpha,0, 1,  0.8),
                noise:          clamp(rp.crt?.noise,          0, 1,  0.1),
            },
            noise: {
                noise: clamp(rp.noise?.noise, 0, 1, 0.2),
            },
            alpha: {
                alpha: clamp(rp.alpha?.alpha, 0, 1, 0.8),
            },
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the final model URL from current settings
// ─────────────────────────────────────────────────────────────────────────────

export function resolveModelUrl(settings) {
    switch (settings.modelSource) {
        case MODEL_SOURCE.URL:
            return settings.customUrl.trim() || null;
        case MODEL_SOURCE.LOCAL:
            return settings.localPath.trim() || null;
        case MODEL_SOURCE.DEFAULT:
        default:
            return DEFAULT_MODEL_URL;
    }
}
