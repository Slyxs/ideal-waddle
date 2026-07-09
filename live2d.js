/**
 * live2d.js — Live2D+ canvas & model management
 *
 * Manages the PIXI application, model loading, transforms,
 * cursor tracking, dragging, and filter application.
 * All PIXI globals (PIXI, PIXI.live2d) must be loaded before
 * calling any function here.
 */

const DEBUG_PREFIX = '[Live2D+]';
const OVERLAY_ID = 'live2d-plus-overlay';
const CANVAS_ID = 'live2d-plus-canvas';
const MOTION_PRIORITY_FORCE = 3;

// -- Module state -------------------------------------------------------------

let _app = null;        // PIXI.Application
let _model = null;      // PIXI.live2d.Live2DModel
let _overlay = null;    // fixed overlay <div>
let _canvas = null;     // <canvas> element inside overlay
let _settings = null;   // reference to current settings snapshot
let _followEnabled = false;
let _draggable = false;
let _dragState = null;  // { startX, startY, originLeft, originTop }

// -- Internal helpers ---------------------------------------------------------

function log(...args) {
    console.debug(DEBUG_PREFIX, ...args);
}

function getOverlay() {
    return document.getElementById(OVERLAY_ID);
}

function hexToNumber(color) {
    const str = typeof color === 'string' ? color.replace('#', '') : '';
    const val = parseInt(str, 16);
    return isFinite(val) ? val : 0x805ad5;
}

// -- Overlay lifecycle --------------------------------------------------------

function createOverlay(settings) {
    let overlay = getOverlay();
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.zIndex = settings.zIndex;
    if (settings.draggable) overlay.classList.add('draggable');
    document.body.appendChild(overlay);
    _overlay = overlay;
    return overlay;
}

function removeOverlay() {
    const el = getOverlay();
    if (el) el.remove();
    _overlay = null;
    _canvas = null;
}

// -- PIXI application ---------------------------------------------------------

async function createPixiApp(settings) {
    const PIXI = window.PIXI;
    if (!PIXI) throw new Error('PIXI is not loaded.');

    const canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    canvas.width = settings.canvasWidth;
    canvas.height = settings.canvasHeight;
    positionCanvas(canvas, settings);
    _overlay.appendChild(canvas);
    _canvas = canvas;

    const app = new PIXI.Application({
        view: canvas,
        width: settings.canvasWidth,
        height: settings.canvasHeight,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
    });

    _app = app;
    return app;
}

function destroyPixiApp() {
    if (_app) {
        try { _app.destroy(true, { children: true }); } catch (_) { /* ignore */ }
        _app = null;
    }
    _model = null;
}

// -- Canvas positioning -------------------------------------------------------

function positionCanvas(canvas, settings) {
    const w = settings.canvasWidth;
    const h = settings.canvasHeight;
    const left = (window.innerWidth * settings.positionX / 100) - (w / 2);
    const top  = (window.innerHeight * settings.positionY / 100) - (h / 2);

    canvas.style.position = 'absolute';
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.left   = left + 'px';
    canvas.style.top    = top  + 'px';
    canvas.style.opacity = settings.opacity;
    canvas.style.pointerEvents = settings.draggable ? 'auto' : 'none';
}

// -- Model loading ------------------------------------------------------------

async function loadModel(url, settings, onReady) {
    if (!_app) {
        log('No PIXI app — cannot load model.');
        return;
    }

    const PIXI = window.PIXI;
    const Live2DModel = PIXI?.live2d?.Live2DModel;
    if (!Live2DModel) throw new Error('Live2DModel is not available.');

    // Remove previous model
    if (_model) {
        try { _app.stage.removeChild(_model); } catch (_) { /* ignore */ }
        try { _model.destroy(); } catch (_) { /* ignore */ }
        _model = null;
    }

    log('Loading model:', url);

    const model = await Live2DModel.from(url, { autoInteract: false });
    _model = model;
    _app.stage.addChild(model);

    applyModelTransform(model, settings);
    applyFilters(model, settings);

    if (settings.followCursor) enableFollowCursor();
    if (settings.draggable) enableDragging();

    if (typeof onReady === 'function') onReady(model);

    log('Model loaded:', model);
    return model;
}

// -- Model transform ----------------------------------------------------------

function applyModelTransform(model, settings) {
    if (!model) return;
    model.scale.set(settings.scale);
    model.x = (settings.canvasWidth  * settings.modelOffsetX / 100);
    model.y = (settings.canvasHeight * settings.modelOffsetY / 100);
    if (model.anchor?.set) {
        model.anchor.set(0.5, 0.5);
    }
}

// -- Filters ------------------------------------------------------------------

function buildFilters(settings) {
    const PIXI = window.PIXI;
    const f = settings.filters || {};
    const fp = settings.filterParams || {};
    const filters = [];

    if (f.outline) {
        const OutlineFilter = PIXI?.filters?.OutlineFilter;
        if (OutlineFilter) {
            const p = fp.outline || {};
            filters.push(new OutlineFilter(
                p.thickness ?? 2,
                hexToNumber(p.color ?? '#805ad5'),
                1.0
            ));
        }
    }

    if (f.pixelate) {
        const PixelateFilter = PIXI?.filters?.PixelateFilter;
        if (PixelateFilter) {
            const p = fp.pixelate || {};
            filters.push(new PixelateFilter(p.size ?? 5));
        }
    }

    if (f.crt) {
        const CRTFilter = PIXI?.filters?.CRTFilter;
        if (CRTFilter) {
            const p = fp.crt || {};
            const crt = new CRTFilter();
            crt.curvature    = p.curvature    ?? 3;
            crt.lineWidth    = p.lineWidth    ?? 3;
            crt.lineContrast = p.lineContrast ?? 0.2;
            crt.noise        = p.noise        ?? 0.1;
            crt.vignetting   = p.vignetting   ?? 0.3;
            filters.push(crt);
        }
    }

    if (f.noise) {
        const NoiseFilter = PIXI?.filters?.NoiseFilter;
        if (NoiseFilter) {
            const p = fp.noise || {};
            filters.push(new NoiseFilter(p.noise ?? 0.2));
        }
    }

    if (f.alpha) {
        const AlphaFilter = PIXI?.filters?.AlphaFilter;
        if (AlphaFilter) {
            const p = fp.alpha || {};
            filters.push(new AlphaFilter(p.alpha ?? 0.8));
        }
    }

    return filters;
}

function applyFilters(model, settings) {
    if (!model) return;
    model.filters = buildFilters(settings);
}

// -- Follow cursor ------------------------------------------------------------

function onMouseMove(event) {
    if (!_model || !_followEnabled) return;
    if (!_canvas) return;

    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width  / rect.width;
    const scaleY = _canvas.height / rect.height;
    const localX = (event.clientX - rect.left) * scaleX;
    const localY = (event.clientY - rect.top)  * scaleY;

    _model.focus(localX, localY);
}

function enableFollowCursor() {
    _followEnabled = true;
    document.addEventListener('mousemove', onMouseMove);
}

function disableFollowCursor() {
    _followEnabled = false;
    document.removeEventListener('mousemove', onMouseMove);
}

// -- Dragging -----------------------------------------------------------------

function onCanvasPointerDown(event) {
    if (!_draggable) return;
    event.preventDefault();

    const canvas = _canvas;
    _dragState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originLeft: parseFloat(canvas.style.left) || 0,
        originTop:  parseFloat(canvas.style.top)  || 0,
    };
    canvas.setPointerCapture?.(event.pointerId);
}

function onCanvasPointerMove(event) {
    if (!_dragState || _dragState.pointerId !== event.pointerId) return;
    const dx = event.clientX - _dragState.startClientX;
    const dy = event.clientY - _dragState.startClientY;
    _canvas.style.left = (_dragState.originLeft + dx) + 'px';
    _canvas.style.top  = (_dragState.originTop  + dy) + 'px';
}

function onCanvasPointerUp(event) {
    if (!_dragState || _dragState.pointerId !== event.pointerId) return;
    _canvas.releasePointerCapture?.(event.pointerId);
    _dragState = null;

    // Persist position as percentage in settings
    if (_settings) {
        const left = parseFloat(_canvas.style.left) + (_settings.canvasWidth  / 2);
        const top  = parseFloat(_canvas.style.top)  + (_settings.canvasHeight / 2);
        _settings.positionX = parseFloat(((left  / window.innerWidth)  * 100).toFixed(2));
        _settings.positionY = parseFloat(((top   / window.innerHeight) * 100).toFixed(2));
    }
}

function enableDragging() {
    if (!_canvas) return;
    _draggable = true;
    _canvas.style.cursor = 'grab';
    _canvas.style.pointerEvents = 'auto';
    _canvas.addEventListener('pointerdown', onCanvasPointerDown);
    _canvas.addEventListener('pointermove', onCanvasPointerMove);
    _canvas.addEventListener('pointerup',   onCanvasPointerUp);
    _canvas.addEventListener('pointercancel', onCanvasPointerUp);
    if (_overlay) _overlay.classList.add('draggable');
}

function disableDragging() {
    if (!_canvas) return;
    _draggable = false;
    _canvas.style.cursor = '';
    _canvas.style.pointerEvents = 'none';
    _canvas.removeEventListener('pointerdown', onCanvasPointerDown);
    _canvas.removeEventListener('pointermove', onCanvasPointerMove);
    _canvas.removeEventListener('pointerup',   onCanvasPointerUp);
    _canvas.removeEventListener('pointercancel', onCanvasPointerUp);
    if (_overlay) _overlay.classList.remove('draggable');
}

// -- Model info (for test UI) -------------------------------------------------

function getModelInfo() {
    if (!_model) return { motions: {}, expressions: [] };

    const mm = _model.internalModel?.motionManager;
    const motions = mm?.definitions || {};
    const rawExpressions =
        mm?.expressionManager?.definitions ||
        _model.internalModel?.settings?.expressions ||
        [];
    const expressions = Array.isArray(rawExpressions)
        ? rawExpressions
        : Object.values(rawExpressions).filter(Boolean);

    return { motions, expressions };
}

// -- Play motion / expression -------------------------------------------------

async function playMotion(groupName, index) {
    if (!_model) return false;
    try {
        await _model.motion(groupName, Number(index), MOTION_PRIORITY_FORCE);
        return true;
    } catch (err) {
        log('playMotion error:', err);
        return false;
    }
}

async function playExpression(value) {
    if (!_model) return false;
    try {
        await _model.expression(value);
        return true;
    } catch (err) {
        log('playExpression error:', err);
        return false;
    }
}

// -- Public API ---------------------------------------------------------------

/**
 * Initialize the overlay, PIXI app, and load the model.
 * @param {object} settings  - current extension settings
 * @param {string} url       - resolved model URL
 * @param {function} onReady - called with model after load
 */
export async function initLive2D(settings, url, onReady) {
    _settings = settings;

    destroyPixiApp();
    removeOverlay();

    createOverlay(settings);
    await createPixiApp(settings);

    if (settings.followCursor) enableFollowCursor();
    else disableFollowCursor();

    if (settings.draggable) enableDragging();
    else disableDragging();

    return loadModel(url, settings, onReady);
}

/**
 * Destroy the PIXI app and remove the overlay entirely.
 */
export function destroyLive2D() {
    disableFollowCursor();
    disableDragging();
    destroyPixiApp();
    removeOverlay();
    _settings = null;
    log('Destroyed.');
}

/**
 * Reload just the model (app stays alive).
 * @param {object} settings
 * @param {string} url
 * @param {function} onReady
 */
export function reloadModel(settings, url, onReady) {
    _settings = settings;
    return loadModel(url, settings, onReady);
}

/**
 * Update canvas size and re-position canvas element without reloading model.
 * @param {object} settings
 */
export function updateCanvasSize(settings) {
    if (!_canvas || !_app) return;
    _canvas.width  = settings.canvasWidth;
    _canvas.height = settings.canvasHeight;
    _app.renderer.resize(settings.canvasWidth, settings.canvasHeight);
    positionCanvas(_canvas, settings);
    if (_model) applyModelTransform(_model, settings);
    if (_overlay) _overlay.style.zIndex = settings.zIndex;
}

/**
 * Update model scale/position without reloading.
 * @param {object} settings
 */
export function updateModelTransform(settings) {
    if (!_canvas) return;
    positionCanvas(_canvas, settings);
    if (_model) applyModelTransform(_model, settings);
    if (_overlay) _overlay.style.zIndex = settings.zIndex;
}

/**
 * Toggle follow-cursor at runtime.
 * @param {boolean} enabled
 */
export function setFollowCursor(enabled) {
    if (enabled) enableFollowCursor();
    else disableFollowCursor();
}

/**
 * Toggle dragging at runtime.
 * @param {boolean} enabled
 */
export function setDraggable(enabled) {
    if (enabled) enableDragging();
    else disableDragging();
}

/**
 * Re-apply filters from settings to the current model.
 * @param {object} settings
 */
export function updateFilters(settings) {
    if (_model) applyFilters(_model, settings);
}

/** @returns {{ motions: object, expressions: Array }} */
export { getModelInfo, playMotion, playExpression };
