// ---------------------------------------------------------------------------
// Live2D runtime loading and model utilities
// ---------------------------------------------------------------------------

// The runtime libraries are bundled into this extension's build by Webpack
// (imported below as raw source strings via the `asset/source` rule in
// webpack.config.js). They are legacy browser-global / UMD scripts that must
// run in *global* scope so they can attach to `window` (window.PIXI,
// window.Live2DCubismCore, etc.). We therefore execute them through
// Blob-backed <script> tags rather than as ES modules — this avoids any
// network requests (no 404s) while preserving correct global-scope semantics.
import tweenLiteSource from './lib/TweenLite-1.20.2.js';
import live2dSource from './lib/live2d.min.js';
import cubismCoreSource from './lib/live2dcubismcore.min.js';
import pixiSource from './lib/pixi-7.4.2.min.js';
import pixiLive2DSource from './lib/pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js';
import pixiFiltersSource from './lib/pixi-filters.min.js';

const EXTENSION_FOLDER = 'Extension-Live2D-Plus';
const EXTENSION_WEB_PATH = `/scripts/extensions/third-party/${EXTENSION_FOLDER}`;

// Loaded in dependency order: cores and PIXI first, then the plugins that
// extend window.PIXI (pixi-live2d-display, pixi-filters).
const LIVE2D_RUNTIME_MODULES = [
    { name: 'TweenLite-1.20.2.js', source: tweenLiteSource },
    { name: 'live2d.min.js', source: live2dSource },
    { name: 'live2dcubismcore.min.js', source: cubismCoreSource },
    { name: 'pixi-7.4.2.min.js', source: pixiSource },
    { name: 'pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js', source: pixiLive2DSource },
    { name: 'pixi-filters.min.js', source: pixiFiltersSource },
];

const SCRIPT_ATTR = 'data-live2dplus-src';
const LIVE2D_ALLOWED_AUDIO_URLS_KEY = '__live2dPlusAllowedAudioUrls';
const LIVE2D_SOUND_MANAGER_PATCHED_KEY = '__live2dPlusSoundManagerPatched';
const mutedLive2DSoundElements = new WeakSet();

function normalizeAudioUrl(url) {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value) return '';
    try {
        const anchor = document.createElement('a');
        anchor.href = value;
        return anchor.href;
    } catch {
        return value;
    }
}

function getAllowedLive2DAudioUrls() {
    if (typeof window === 'undefined') return null;
    if (!(window[LIVE2D_ALLOWED_AUDIO_URLS_KEY] instanceof Set)) {
        window[LIVE2D_ALLOWED_AUDIO_URLS_KEY] = new Set();
    }
    return window[LIVE2D_ALLOWED_AUDIO_URLS_KEY];
}

function isAllowedLive2DAudioUrl(url) {
    const allowedUrls = getAllowedLive2DAudioUrls();
    const normalized = normalizeAudioUrl(url);
    return !!normalized && allowedUrls?.has(normalized);
}

function muteLive2DSoundElement(audio) {
    if (!audio) return;
    mutedLive2DSoundElements.add(audio);
    try { audio.muted = true; } catch { /* noop */ }
    try { audio.volume = 0; } catch { /* noop */ }
}

function installLive2DSoundMute(live2d) {
    const soundManager = live2d?.SoundManager;
    if (!soundManager || soundManager[LIVE2D_SOUND_MANAGER_PATCHED_KEY]) return;

    const originalAdd = soundManager.add;
    const originalPlay = soundManager.play;
    if (typeof originalAdd !== 'function' || typeof originalPlay !== 'function') return;

    soundManager.add = function patchedLive2DPlusSoundAdd(url, onFinish, onError, crossOrigin) {
        const audio = originalAdd.call(this, url, onFinish, onError, crossOrigin);
        if (!isAllowedLive2DAudioUrl(audio?.src || url)) {
            muteLive2DSoundElement(audio);
        }
        return audio;
    };

    soundManager.play = function patchedLive2DPlusSoundPlay(audio) {
        if (mutedLive2DSoundElements.has(audio)) {
            muteLive2DSoundElement(audio);
            Promise.resolve().then(() => {
                try { audio.dispatchEvent(new Event('ended')); } catch { /* noop */ }
            });
            return Promise.resolve();
        }
        return originalPlay.apply(this, arguments);
    };

    Object.defineProperty(soundManager, LIVE2D_SOUND_MANAGER_PATCHED_KEY, { value: true });
}

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

export async function loadLive2DRuntime() {
    if (!_runtimePromise) {
        _runtimePromise = (async () => {
            if (typeof document === 'undefined') return;

            for (const { name, source } of LIVE2D_RUNTIME_MODULES) {
                await injectScript(name, source);
            }

            if (!window.Live2DCubismCore) {
                throw new Error(`Cubism 4 core failed to load from ${EXTENSION_WEB_PATH}/lib/live2dcubismcore.min.js`);
            }

            const live2d = window.PIXI?.live2d;
            installLive2DSoundMute(live2d);
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
