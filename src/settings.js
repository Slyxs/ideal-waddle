// ---------------------------------------------------------------------------
// Extension settings: defaults, normalization, helpers
// ---------------------------------------------------------------------------

import { DEFAULT_ANALYSIS_MODEL, DEFAULT_EMOTION_LABELS } from './dynamicAnalysis';

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

export const DEFAULT_PRIORITY_LIST = Object.freeze([
    { priority: 4, type: 'action', target: 'motion', label: 'Action Motions' },
    { priority: 3, type: 'emotion', target: 'expression', label: 'Emotion Expressions' },
    { priority: 2, type: 'emotion', target: 'motion', label: 'Emotion Motions' },
    { priority: 1, type: 'action', target: 'expression', label: 'Action Expressions' },
]);

export const DEFAULT_DISABLE_SETTINGS = Object.freeze({
    emotionMotions: false,
    emotionExpressions: false,
    actionMotions: false,
    actionExpressions: false,
});

export const PER_MODEL_SETTING_KEYS = Object.freeze([
    'resetExpressionAfterPlayback',
    'emotionLabels',
    'emotionMappings',
    'actionMappings',
    'priorityList',
    'disableSettings',
    'canvasWidth',
    'canvasHeight',
    'scale',
    'positionX',
    'positionY',
    'modelPositionX',
    'modelPositionY',
    'opacity',
    'zIndex',
    'filters',
    'filterParams',
]);

const PER_MODEL_SETTING_KEY_SET = new Set(PER_MODEL_SETTING_KEYS);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    followCursor: true,
    draggable: true,
    enableHitTesting: true,
    sttEnabled: false,
    routeTtsToLive2D: true,
    blockOriginalTtsPlayback: true,
    dynamicMode: false,
    resetExpressionAfterPlayback: true,
    voskModelUrl: '',
    analysisBaseUrl: '',
    analysisApiKey: '',
    analysisModel: DEFAULT_ANALYSIS_MODEL,
    emotionLabels: DEFAULT_EMOTION_LABELS,
    emotionMappings: {},
    actionMappings: [],
    priorityList: DEFAULT_PRIORITY_LIST,
    disableSettings: DEFAULT_DISABLE_SETTINGS,
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
    modelSettingsByKey: {},
    activeModelSettingsKey: '',
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

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function cloneSettingValue(value) {
    if (Array.isArray(value)) return value.map((item) => cloneSettingValue(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneSettingValue(item)]));
    }
    return value;
}

function normalizeModelSettingsByKey(source = {}) {
    const profiles = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const normalized = {};
    for (const [rawKey, rawProfile] of Object.entries(profiles)) {
        const key = text(rawKey);
        if (!key || !rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue;
        normalized[key] = cloneSettingValue(rawProfile);
    }
    return normalized;
}

function normalizeLabelList(values, fallback = []) {
    const list = Array.isArray(values) ? values : fallback;
    const seen = new Set();
    const labels = [];
    for (const value of list) {
        const label = text(value);
        const key = label.toLowerCase();
        if (!label || seen.has(key)) continue;
        seen.add(key);
        labels.push(label);
    }
    return labels.length ? labels : [...fallback];
}

function normalizeMappingEntry(value) {
    if (typeof value === 'string') return { motion: text(value), expression: '' };
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        motion: text(source.motion),
        expression: text(source.expression),
    };
}

function normalizeEmotionMappings(source = {}) {
    const mappings = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const normalized = {};
    for (const [rawKey, rawEntry] of Object.entries(mappings)) {
        const key = text(rawKey);
        if (!key) continue;
        const entry = normalizeMappingEntry(rawEntry);
        if (entry.motion || entry.expression) normalized[key] = entry;
    }
    return normalized;
}

function normalizeActionMappings(source = []) {
    const actions = Array.isArray(source) ? source : [];
    return actions.map((action, index) => {
        const entry = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
        return {
            id: text(entry.id) || `action-${index + 1}`,
            description: text(entry.description),
            motion: text(entry.motion),
            expression: text(entry.expression),
        };
    });
}

function normalizePriorityList(source = []) {
    const defaultsByKey = new Map(DEFAULT_PRIORITY_LIST.map((item) => [`${item.type}:${item.target}`, item]));
    const input = Array.isArray(source) ? source : [];
    const ordered = [];
    const seen = new Set();

    input
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .slice()
        .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))
        .forEach((item) => {
            const type = item.type === 'action' ? 'action' : item.type === 'emotion' ? 'emotion' : '';
            const target = item.target === 'motion' ? 'motion' : item.target === 'expression' ? 'expression' : '';
            const key = `${type}:${target}`;
            const defaults = defaultsByKey.get(key);
            if (!defaults || seen.has(key)) return;
            seen.add(key);
            ordered.push({ ...defaults, label: text(item.label) || defaults.label });
        });

    for (const item of DEFAULT_PRIORITY_LIST) {
        const key = `${item.type}:${item.target}`;
        if (!seen.has(key)) ordered.push({ ...item });
    }

    const count = ordered.length;
    return ordered.map((item, index) => ({ ...item, priority: count - index }));
}

function normalizeDisableSettings(source = {}) {
    const settings = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return {
        emotionMotions: bool(settings.emotionMotions, DEFAULT_DISABLE_SETTINGS.emotionMotions),
        emotionExpressions: bool(settings.emotionExpressions, DEFAULT_DISABLE_SETTINGS.emotionExpressions),
        actionMotions: bool(settings.actionMotions, DEFAULT_DISABLE_SETTINGS.actionMotions),
        actionExpressions: bool(settings.actionExpressions, DEFAULT_DISABLE_SETTINGS.actionExpressions),
    };
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
        sttEnabled: bool(src.sttEnabled, DEFAULT_SETTINGS.sttEnabled),
        routeTtsToLive2D: bool(src.routeTtsToLive2D, DEFAULT_SETTINGS.routeTtsToLive2D),
        blockOriginalTtsPlayback: bool(src.blockOriginalTtsPlayback, DEFAULT_SETTINGS.blockOriginalTtsPlayback),
        dynamicMode: bool(src.dynamicMode, DEFAULT_SETTINGS.dynamicMode),
        resetExpressionAfterPlayback: bool(src.resetExpressionAfterPlayback, DEFAULT_SETTINGS.resetExpressionAfterPlayback),
        voskModelUrl: typeof src.voskModelUrl === 'string' ? src.voskModelUrl : '',
        analysisBaseUrl: text(src.analysisBaseUrl),
        analysisApiKey: typeof src.analysisApiKey === 'string' ? src.analysisApiKey : '',
        analysisModel: text(src.analysisModel) || DEFAULT_ANALYSIS_MODEL,
        emotionLabels: normalizeLabelList(src.emotionLabels, DEFAULT_EMOTION_LABELS),
        emotionMappings: normalizeEmotionMappings(src.emotionMappings),
        actionMappings: normalizeActionMappings(src.actionMappings),
        priorityList: normalizePriorityList(src.priorityList),
        disableSettings: normalizeDisableSettings(src.disableSettings),
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
        modelSettingsByKey: normalizeModelSettingsByKey(src.modelSettingsByKey),
        activeModelSettingsKey: text(src.activeModelSettingsKey),
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

export function resolveModelSettingsKey(settings) {
    const normalized = normalizeSettings(settings);
    return `${normalized.modelSource}:${resolveModelUrl(normalized) || 'unconfigured'}`;
}

export function resolveEffectiveSettings(settings = {}) {
    const base = normalizeSettings(settings);
    const modelKey = resolveModelSettingsKey(base);
    const profile = base.modelSettingsByKey?.[modelKey];
    if (!profile) return { ...base, activeModelSettingsKey: modelKey };
    const effective = normalizeSettings({
        ...base,
        ...profile,
        modelSettingsByKey: base.modelSettingsByKey,
    });
    return { ...effective, activeModelSettingsKey: modelKey };
}

export function pickModelSettings(settings = {}) {
    const normalized = normalizeSettings(settings);
    return Object.fromEntries(
        PER_MODEL_SETTING_KEYS.map((key) => [key, cloneSettingValue(normalized[key])])
    );
}

export function splitModelSettingsPatch(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const modelPatch = {};
    const globalPatch = {};
    for (const [key, value] of Object.entries(source)) {
        if (PER_MODEL_SETTING_KEY_SET.has(key)) modelPatch[key] = value;
        else globalPatch[key] = value;
    }
    return { modelPatch, globalPatch };
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
