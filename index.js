/**
 * index.js — Live2D+ Extension entry point
 *
 * Loads PIXI + Live2D libraries, injects the settings panel into ST,
 * manages settings persistence, and wires up all UI events.
 */

import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import { loadFileToDocument } from '../../../utils.js';
import {
    initLive2D,
    destroyLive2D,
    reloadModel,
    updateCanvasSize,
    updateModelTransform,
    setFollowCursor,
    setDraggable,
    updateFilters,
    getModelInfo,
    playMotion,
    playExpression,
} from './live2d.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODULE_NAME    = 'live2d_plus';
const DEBUG_PREFIX   = '[Live2D+]';
const EXTENSION_FOLDER = 'scripts/extensions/third-party/Extension-Live2D+';
const DEFAULT_MODEL_URL = 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/shizuku/shizuku.model.json';

// ---------------------------------------------------------------------------
// Load PIXI + Live2D libraries (top-level await — ES module)
// ---------------------------------------------------------------------------

const LIBS = [
    'TweenLite-1.20.2.js',
    'live2dcubismcore.min.js',
    'live2d.min.js',
    'pixi-7.4.2.min.js',
    'pixi-live2d-display-lipsyncpatch-0.5.0-ls-8.min.js',
    'pixi-filters.min.js',
];

for (const lib of LIBS) {
    await loadFileToDocument(`${EXTENSION_FOLDER}/lib/${lib}`, 'js');
}

console.debug(DEBUG_PREFIX, 'Libraries loaded.');

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
    enabled:          false,
    modelSource:      'default',   // 'default' | 'url' | 'local'
    customModelUrl:   '',
    localModelPath:   '',
    canvasWidth:      800,
    canvasHeight:     800,
    scale:            0.4,
    positionX:        80,
    positionY:        60,
    modelOffsetX:     50,
    modelOffsetY:     50,
    opacity:          1.0,
    zIndex:           35,
    followCursor:     false,
    draggable:        true,
    filters: {
        outline:   false,
        pixelate:  false,
        crt:       false,
        noise:     false,
        alpha:     false,
    },
    filterParams: {
        outline:  { thickness: 2, color: '#805ad5' },
        pixelate: { size: 5 },
        crt:      { curvature: 3, lineWidth: 3, lineContrast: 0.2, vignetting: 0.3, noise: 0.1 },
        noise:    { noise: 0.2 },
        alpha:    { alpha: 0.8 },
    },
});

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULTS);
    }
    const s = extension_settings[MODULE_NAME];

    // Back-fill any missing top-level keys
    for (const [key, val] of Object.entries(DEFAULTS)) {
        if (s[key] === undefined) {
            s[key] = typeof val === 'object' && val !== null ? structuredClone(val) : val;
        }
    }
    // Back-fill nested filter toggles
    if (!s.filters)      s.filters      = structuredClone(DEFAULTS.filters);
    if (!s.filterParams) s.filterParams = structuredClone(DEFAULTS.filterParams);
    for (const [k, v] of Object.entries(DEFAULTS.filters)) {
        if (s.filters[k] === undefined) s.filters[k] = v;
    }
    for (const [k, v] of Object.entries(DEFAULTS.filterParams)) {
        if (!s.filterParams[k]) s.filterParams[k] = structuredClone(v);
    }
}

function resolveModelUrl() {
    const s = getSettings();
    if (s.modelSource === 'url'   && s.customModelUrl)  return s.customModelUrl;
    if (s.modelSource === 'local' && s.localModelPath)  return s.localModelPath;
    return DEFAULT_MODEL_URL;
}

function save() {
    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(id, message) {
    $(`#${id}`).text(message);
}

function updateModelSourceVisibility(source) {
    $('#l2dplus_url_row').toggle(source === 'url');
    $('#l2dplus_local_row').toggle(source === 'local');
}

function toggleFilterParams(filterId, visible) {
    const el = document.getElementById(filterId);
    if (!el) return;
    if (visible) el.classList.add('visible');
    else         el.classList.remove('visible');
}

function applyToUI() {
    const s = getSettings();

    // Global
    $('#l2dplus_enabled').prop('checked', s.enabled);
    $('#l2dplus_follow_cursor').prop('checked', s.followCursor);
    $('#l2dplus_draggable').prop('checked', s.draggable);

    // Model
    $('#l2dplus_model_source').val(s.modelSource);
    updateModelSourceVisibility(s.modelSource);
    $('#l2dplus_custom_url').val(s.customModelUrl);
    $('#l2dplus_local_path').val(s.localModelPath);

    // Rendering
    $('#l2dplus_canvas_width').val(s.canvasWidth);
    $('#l2dplus_canvas_width_val').text(s.canvasWidth);
    $('#l2dplus_canvas_height').val(s.canvasHeight);
    $('#l2dplus_canvas_height_val').text(s.canvasHeight);
    $('#l2dplus_scale').val(s.scale);
    $('#l2dplus_scale_val').text(s.scale.toFixed(2));
    $('#l2dplus_pos_x').val(s.positionX);
    $('#l2dplus_pos_x_val').text(s.positionX);
    $('#l2dplus_pos_y').val(s.positionY);
    $('#l2dplus_pos_y_val').text(s.positionY);
    $('#l2dplus_model_offset_x').val(s.modelOffsetX);
    $('#l2dplus_model_offset_x_val').text(s.modelOffsetX);
    $('#l2dplus_model_offset_y').val(s.modelOffsetY);
    $('#l2dplus_model_offset_y_val').text(s.modelOffsetY);
    $('#l2dplus_opacity').val(s.opacity);
    $('#l2dplus_opacity_val').text(s.opacity.toFixed(2));
    $('#l2dplus_zindex').val(s.zIndex);
    $('#l2dplus_zindex_val').text(s.zIndex);

    // Filters
    const f  = s.filters;
    const fp = s.filterParams;

    $('#l2dplus_filter_outline').prop('checked', f.outline);
    toggleFilterParams('l2dplus_outline_params', f.outline);
    $('#l2dplus_outline_thickness').val(fp.outline.thickness);
    $('#l2dplus_outline_thickness_val').text(fp.outline.thickness);
    $('#l2dplus_outline_color').val(fp.outline.color);

    $('#l2dplus_filter_pixelate').prop('checked', f.pixelate);
    toggleFilterParams('l2dplus_pixelate_params', f.pixelate);
    $('#l2dplus_pixelate_size').val(fp.pixelate.size);
    $('#l2dplus_pixelate_size_val').text(fp.pixelate.size);

    $('#l2dplus_filter_crt').prop('checked', f.crt);
    toggleFilterParams('l2dplus_crt_params', f.crt);
    $('#l2dplus_crt_curvature').val(fp.crt.curvature);
    $('#l2dplus_crt_curvature_val').text(fp.crt.curvature);
    $('#l2dplus_crt_noise').val(fp.crt.noise);
    $('#l2dplus_crt_noise_val').text(fp.crt.noise.toFixed(2));
    $('#l2dplus_crt_vignetting').val(fp.crt.vignetting);
    $('#l2dplus_crt_vignetting_val').text(fp.crt.vignetting.toFixed(2));

    $('#l2dplus_filter_noise').prop('checked', f.noise);
    toggleFilterParams('l2dplus_noise_params', f.noise);
    $('#l2dplus_noise_level').val(fp.noise.noise);
    $('#l2dplus_noise_level_val').text(fp.noise.noise.toFixed(2));

    $('#l2dplus_filter_alpha').prop('checked', f.alpha);
    toggleFilterParams('l2dplus_alpha_params', f.alpha);
    $('#l2dplus_alpha_filter').val(fp.alpha.alpha);
    $('#l2dplus_alpha_val').text(fp.alpha.alpha.toFixed(2));
}

// ---------------------------------------------------------------------------
// Test UI — populate motion/expression selects from loaded model
// ---------------------------------------------------------------------------

function populateTestUI() {
    const { motions, expressions } = getModelInfo();

    // Motion groups
    const $group = $('#l2dplus_test_motion_group').empty();
    const groups = Object.keys(motions).filter(g => Array.isArray(motions[g]) && motions[g].length > 0);
    if (groups.length === 0) {
        $group.append('<option value="">-- No motions --</option>');
    } else {
        groups.forEach(g => $group.append(`<option value="${g}">${g}</option>`));
        // Trigger motion index population for first group
        populateMotionIndices(groups[0], motions);
    }

    // Expressions
    const $expr = $('#l2dplus_test_expression').empty();
    if (expressions.length === 0) {
        $expr.append('<option value="">-- No expressions --</option>');
    } else {
        expressions.forEach((expr, i) => {
            const label = typeof expr === 'string'
                ? expr.replace(/\.(exp3?|json)$/i, '')
                : (expr?.name || expr?.Name || expr?.File || `Expression ${i}`);
            $expr.append(`<option value="${i}">${label}</option>`);
        });
    }
}

function populateMotionIndices(groupName, motions) {
    const $idx = $('#l2dplus_test_motion_index').empty();
    const list = motions?.[groupName];
    if (!Array.isArray(list) || list.length === 0) {
        $idx.append('<option value="">-- No motions --</option>');
        return;
    }
    list.forEach((m, i) => {
        const raw = typeof m === 'string' ? m : (m?.File || m?.file || m?.name || `Motion ${i + 1}`);
        const label = String(raw).replace(/\.(mtn|motion3\.json|json)$/i, '');
        $idx.append(`<option value="${i}">${label}</option>`);
    });
}

// ---------------------------------------------------------------------------
// jQuery ready — inject UI and bind events
// ---------------------------------------------------------------------------

jQuery(async () => {
    // -- Inject settings HTML ------------------------------------------------
    const settingsHtml = await $.get(`${EXTENSION_FOLDER}/window.html`);
    const container =
        document.getElementById('extensions_settings2') ||
        document.getElementById('extensions_settings');

    if (!container) {
        console.error(DEBUG_PREFIX, 'Could not find extensions_settings container.');
        return;
    }

    $(container).append(settingsHtml);
    loadSettings();
    applyToUI();

    // -- Auto-start if previously enabled ------------------------------------
    if (getSettings().enabled) {
        setStatus('l2dplus_model_status', 'Loading…');
        try {
            await initLive2D(getSettings(), resolveModelUrl(), () => {
                setStatus('l2dplus_model_status', 'Model ready.');
                populateTestUI();
            });
        } catch (err) {
            console.error(DEBUG_PREFIX, 'Auto-start failed:', err);
            setStatus('l2dplus_model_status', 'Failed to load model: ' + err.message);
        }
    }

    // ── Global ──────────────────────────────────────────────────────────────

    $('#l2dplus_enabled').on('change', async function () {
        getSettings().enabled = this.checked;
        save();
        if (this.checked) {
            setStatus('l2dplus_model_status', 'Loading…');
            try {
                await initLive2D(getSettings(), resolveModelUrl(), () => {
                    setStatus('l2dplus_model_status', 'Model ready.');
                    populateTestUI();
                });
            } catch (err) {
                console.error(DEBUG_PREFIX, err);
                setStatus('l2dplus_model_status', 'Error: ' + err.message);
                getSettings().enabled = false;
                $('#l2dplus_enabled').prop('checked', false);
                save();
            }
        } else {
            destroyLive2D();
            setStatus('l2dplus_model_status', 'Disabled.');
        }
    });

    $('#l2dplus_follow_cursor').on('change', function () {
        getSettings().followCursor = this.checked;
        save();
        setFollowCursor(this.checked);
    });

    $('#l2dplus_draggable').on('change', function () {
        getSettings().draggable = this.checked;
        save();
        setDraggable(this.checked);
    });

    // ── Model ────────────────────────────────────────────────────────────────

    $('#l2dplus_model_source').on('change', function () {
        getSettings().modelSource = this.value;
        updateModelSourceVisibility(this.value);
        save();
    });

    $('#l2dplus_custom_url').on('input', function () {
        getSettings().customModelUrl = this.value.trim();
        save();
    });

    $('#l2dplus_local_path').on('input', function () {
        getSettings().localModelPath = this.value.trim();
        save();
    });

    $('#l2dplus_reload_btn').on('click', async () => {
        if (!getSettings().enabled) {
            setStatus('l2dplus_model_status', 'Enable Live2D first.');
            return;
        }
        setStatus('l2dplus_model_status', 'Reloading…');
        try {
            await reloadModel(getSettings(), resolveModelUrl(), () => {
                setStatus('l2dplus_model_status', 'Model ready.');
                populateTestUI();
            });
        } catch (err) {
            console.error(DEBUG_PREFIX, err);
            setStatus('l2dplus_model_status', 'Error: ' + err.message);
        }
    });

    // ── Rendering ────────────────────────────────────────────────────────────

    function makeRangeHandler(settingKey, displayId, parse, callback) {
        return function () {
            const v = parse(this.value);
            getSettings()[settingKey] = v;
            $(`#${displayId}`).text(typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v);
            save();
            if (typeof callback === 'function') callback(v);
        };
    }

    $('#l2dplus_canvas_width').on('input', makeRangeHandler(
        'canvasWidth', 'l2dplus_canvas_width_val', parseInt,
        () => updateCanvasSize(getSettings())
    ));
    $('#l2dplus_canvas_height').on('input', makeRangeHandler(
        'canvasHeight', 'l2dplus_canvas_height_val', parseInt,
        () => updateCanvasSize(getSettings())
    ));
    $('#l2dplus_scale').on('input', makeRangeHandler(
        'scale', 'l2dplus_scale_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_pos_x').on('input', makeRangeHandler(
        'positionX', 'l2dplus_pos_x_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_pos_y').on('input', makeRangeHandler(
        'positionY', 'l2dplus_pos_y_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_model_offset_x').on('input', makeRangeHandler(
        'modelOffsetX', 'l2dplus_model_offset_x_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_model_offset_y').on('input', makeRangeHandler(
        'modelOffsetY', 'l2dplus_model_offset_y_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_opacity').on('input', makeRangeHandler(
        'opacity', 'l2dplus_opacity_val', parseFloat,
        () => updateModelTransform(getSettings())
    ));
    $('#l2dplus_zindex').on('input', makeRangeHandler(
        'zIndex', 'l2dplus_zindex_val', parseInt,
        () => updateModelTransform(getSettings())
    ));

    // ── Filters ──────────────────────────────────────────────────────────────

    function makeFilterToggle(filterKey, paramsId) {
        return function () {
            getSettings().filters[filterKey] = this.checked;
            toggleFilterParams(paramsId, this.checked);
            save();
            updateFilters(getSettings());
        };
    }

    function makeFilterParam(filterKey, paramKey, displayId, parse) {
        return function () {
            const v = parse(this.value);
            getSettings().filterParams[filterKey][paramKey] = v;
            $(`#${displayId}`).text(typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v);
            save();
            updateFilters(getSettings());
        };
    }

    // Outline
    $('#l2dplus_filter_outline').on('change', makeFilterToggle('outline', 'l2dplus_outline_params'));
    $('#l2dplus_outline_thickness').on('input', makeFilterParam('outline', 'thickness', 'l2dplus_outline_thickness_val', parseInt));
    $('#l2dplus_outline_color').on('input', function () {
        getSettings().filterParams.outline.color = this.value;
        save();
        updateFilters(getSettings());
    });

    // Pixelate
    $('#l2dplus_filter_pixelate').on('change', makeFilterToggle('pixelate', 'l2dplus_pixelate_params'));
    $('#l2dplus_pixelate_size').on('input', makeFilterParam('pixelate', 'size', 'l2dplus_pixelate_size_val', parseInt));

    // CRT
    $('#l2dplus_filter_crt').on('change', makeFilterToggle('crt', 'l2dplus_crt_params'));
    $('#l2dplus_crt_curvature').on('input', makeFilterParam('crt', 'curvature', 'l2dplus_crt_curvature_val', parseFloat));
    $('#l2dplus_crt_noise').on('input', makeFilterParam('crt', 'noise', 'l2dplus_crt_noise_val', parseFloat));
    $('#l2dplus_crt_vignetting').on('input', makeFilterParam('crt', 'vignetting', 'l2dplus_crt_vignetting_val', parseFloat));

    // Noise
    $('#l2dplus_filter_noise').on('change', makeFilterToggle('noise', 'l2dplus_noise_params'));
    $('#l2dplus_noise_level').on('input', makeFilterParam('noise', 'noise', 'l2dplus_noise_level_val', parseFloat));

    // Alpha
    $('#l2dplus_filter_alpha').on('change', makeFilterToggle('alpha', 'l2dplus_alpha_params'));
    $('#l2dplus_alpha_filter').on('input', makeFilterParam('alpha', 'alpha', 'l2dplus_alpha_val', parseFloat));

    // ── Test: motion group selection ─────────────────────────────────────────

    $('#l2dplus_test_motion_group').on('change', function () {
        const { motions } = getModelInfo();
        populateMotionIndices(this.value, motions);
    });

    $('#l2dplus_test_play_motion').on('click', async () => {
        const group = $('#l2dplus_test_motion_group').val();
        const idx   = $('#l2dplus_test_motion_index').val();
        if (!group || idx === '') {
            setStatus('l2dplus_test_status', 'Select a group and motion first.');
            return;
        }
        const ok = await playMotion(group, parseInt(idx, 10));
        setStatus('l2dplus_test_status', ok ? `Playing ${group}[${idx}]` : 'Failed.');
    });

    $('#l2dplus_test_play_expression').on('click', async () => {
        const val = $('#l2dplus_test_expression').val();
        if (val === '') {
            setStatus('l2dplus_test_status', 'Select an expression first.');
            return;
        }
        const ok = await playExpression(parseInt(val, 10));
        setStatus('l2dplus_test_status', ok ? `Playing expression ${val}` : 'Failed.');
    });

    console.debug(DEBUG_PREFIX, 'Extension loaded.');
});
