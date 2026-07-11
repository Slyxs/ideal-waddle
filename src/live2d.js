// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

import * as PIXI from 'pixi.js';
import { CRTFilter, OutlineFilter, PixelateFilter } from 'pixi-filters';

// pixi-live2d-display is now loaded from npm after the legacy Cubism runtime
// globals are available. These core scripts are not provided by the installed
// npm packages and still need global-scope execution.
import tweenLiteSource from './lib/TweenLite-1.20.2.js';
import live2dSource from './lib/live2d.min.js';
import cubismCoreSource from './lib/live2dcubismcore.min.js';

const EXTENSION_FOLDER = 'Extension-Live2D-Plus';
const EXTENSION_WEB_PATH = `/scripts/extensions/third-party/${EXTENSION_FOLDER}`;

const PIXI_RUNTIME = {
    ...PIXI,
    filters: {
        ...(PIXI.filters || {}),
        AlphaFilter: PIXI.AlphaFilter,
        CRTFilter,
        NoiseFilter: PIXI.NoiseFilter,
        OutlineFilter,
        PixelateFilter,
    },
};

// Loaded in dependency order before importing pixi-live2d-display from npm.
const LIVE2D_CORE_MODULES = [
    { name: 'TweenLite-1.20.2.js', source: tweenLiteSource },
    { name: 'live2d.min.js', source: live2dSource },
    { name: 'live2dcubismcore.min.js', source: cubismCoreSource },
];

const SCRIPT_ATTR = 'data-live2dplus-src';
const MOTION_AUDIO_PATCHED = '__live2dPlusMotionAudioPatched';

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

function findScript(name) {
    return document.querySelector(`script[${SCRIPT_ATTR}="${name}"]`);
}

// Execute a bundled library in global scope via a Blob-backed <script> tag.
// Global-scope execution is required so plain `var Foo = ...` libraries and
// UMD builds attach to `window` instead of being trapped in a module closure.
function injectScript(name, source) {
    return new Promise((resolve, reject) => {
        const existing = findScript(name);
        if (existing) {
            if (existing.dataset.loaded === 'true') return resolve();
            existing.remove();
        }

        const blob = new Blob(
            [`${source}\n//# sourceURL=${EXTENSION_WEB_PATH}/lib/${name}`],
            { type: 'text/javascript' },
        );
        const blobUrl = URL.createObjectURL(blob);

        const el = document.createElement('script');
        el.src = blobUrl;
        // async=false preserves execution order for sequentially appended scripts.
        el.async = false;
        el.type = 'text/javascript';
        el.setAttribute(SCRIPT_ATTR, name);
        el.addEventListener('load', () => {
            el.dataset.loaded = 'true';
            URL.revokeObjectURL(blobUrl);
            resolve();
        }, { once: true });
        el.addEventListener('error', () => {
            URL.revokeObjectURL(blobUrl);
            reject(new Error(`Failed to execute bundled library: ${name}`));
        }, { once: true });
        document.head.appendChild(el);
    });
}

let _runtimePromise = null;
let _live2DModulePromise = null;

async function loadLive2DModule() {
    if (!_live2DModulePromise) {
        _live2DModulePromise = import('pixi-live2d-display-lipsyncpatch');
    }

    return _live2DModulePromise;
}

function exposePixiGlobal() {
    if (typeof window !== 'undefined') {
        window.PIXI = PIXI_RUNTIME;
    }
}

function muteLive2DSoundManager(soundManager) {
    soundManager = soundManager || window.PIXI?.live2d?.SoundManager;
    if (soundManager) {
        soundManager.volume = 0;
    }
}

export async function loadLive2DRuntime() {
    if (!_runtimePromise) {
        _runtimePromise = (async () => {
            if (typeof document === 'undefined') return;

            exposePixiGlobal();

            for (const { name, source } of LIVE2D_CORE_MODULES) {
                await injectScript(name, source);
            }

            if (!window.Live2DCubismCore) {
                throw new Error(`Cubism 4 core failed to load from ${EXTENSION_WEB_PATH}/lib/live2dcubismcore.min.js`);
            }

            const live2d = await loadLive2DModule();
            const Live2DModel = live2d?.Live2DModel;

            if (!Live2DModel) {
                throw new Error('Live2D runtime failed to initialize (Live2DModel missing from npm package).');
            }

            Live2DModel.registerTicker?.(PIXI.Ticker);

            // Default model-bundled motion sounds to silent. The per-model patch
            // below keeps motion playback muted even after speak() raises volume.
            muteLive2DSoundManager(live2d.SoundManager);

            return { PIXI: PIXI_RUNTIME, Live2DModel, SoundManager: live2d.SoundManager };
        })();
    }

    const runtime = await _runtimePromise;

    if (!runtime?.PIXI || !runtime?.Live2DModel) {
        throw new Error('Live2D runtime failed to initialize (PIXI or Live2DModel missing).');
    }

    return runtime;
}

function isPlainOptions(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMotionOptions(priority, options) {
    if (isPlainOptions(priority) && options === undefined) {
        return { priority: undefined, options: priority };
    }

    return { priority, options };
}

function mutedMotionOptions(options) {
    return { ...(isPlainOptions(options) ? options : {}), volume: 0 };
}

export function muteModelMotionAudio(model) {
    const motionManager = model?.internalModel?.motionManager;
    if (!motionManager || motionManager[MOTION_AUDIO_PATCHED]) return;

    muteLive2DSoundManager();

    if (typeof motionManager.startMotion === 'function') {
        const originalStartMotion = motionManager.startMotion.bind(motionManager);
        motionManager.startMotion = (groupName, motionIndex, priority, options) => {
            const normalized = normalizeMotionOptions(priority, options);
            return originalStartMotion(
                groupName,
                motionIndex,
                normalized.priority,
                mutedMotionOptions(normalized.options),
            );
        };
    }

    if (typeof motionManager.startRandomMotion === 'function') {
        const originalStartRandomMotion = motionManager.startRandomMotion.bind(motionManager);
        motionManager.startRandomMotion = (groupName, priority, options) => {
            const normalized = normalizeMotionOptions(priority, options);
            return originalStartRandomMotion(
                groupName,
                normalized.priority,
                mutedMotionOptions(normalized.options),
            );
        };
    }

    try {
        Object.defineProperty(motionManager, MOTION_AUDIO_PATCHED, { value: true });
    } catch {
        motionManager[MOTION_AUDIO_PATCHED] = true;
    }
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
