import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeSettings, resolveModelUrl, MODEL_SOURCES, CAPTION_STYLE_OPTIONS } from './settings';
import { EXTENSION_WEB_PATH } from './stt';
import { fetchOpenAiModels } from './dynamicAnalysis';
import { loadLive2DRuntime, buildFilters, applyModelTransform, applyModelInteraction, muteModelMotionAudio } from './live2d';
import { createLive2DCaptionController } from './captions';

const LIVE2D_PLUS_SETTINGS_STYLES = `
.live2d-plus-settings .field,
.live2d-plus-settings .inline-control {
    display: block;
    margin-bottom: 8px;
}

.live2d-plus-settings .field > span,
.live2d-plus-settings .inline-control > span,
.live2d-plus-settings .section-caption {
    display: block;
    margin-bottom: 4px;
    font-size: 0.85em;
    font-weight: 700;
    opacity: 0.72;
}

.live2d-plus-settings .inline-actions,
.live2d-plus-settings .row-actions {
    display: flex;
    align-items: center;
    gap: 6px;
}

.live2d-plus-settings .inline-actions .text_pole {
    flex: 1 1 auto;
    min-width: 0;
}

.live2d-plus-settings .hint {
    margin: 4px 0 8px;
    font-size: 0.82em;
    opacity: 0.62;
}

.live2d-plus-settings .mapping-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 360px;
    overflow-y: auto;
    padding-right: 2px;
    margin-bottom: 10px;
}

.live2d-plus-settings .mapping-list.compact {
    max-height: none;
}

.live2d-plus-settings .mapping-row {
    display: grid;
    grid-template-columns: minmax(96px, 1fr) minmax(120px, 1fr) minmax(120px, 1fr) auto;
    gap: 6px;
    align-items: end;
    padding: 6px;
    border: 1px solid rgba(128, 128, 128, 0.25);
    border-radius: 6px;
}

.live2d-plus-settings .mapping-row.tap-row {
    grid-template-columns: minmax(96px, 0.8fr) minmax(120px, 1fr) minmax(120px, 1fr) minmax(160px, 1.2fr);
}

.live2d-plus-settings .mapping-row.tap-row textarea.text_pole {
    min-height: 54px;
    resize: vertical;
}

.live2d-plus-settings .priority-row {
    grid-template-columns: 1fr auto;
    align-items: center;
}

.live2d-plus-settings .compact-field {
    margin-bottom: 0;
}

.live2d-plus-settings .mapping-row .text_pole {
    width: 100%;
}

@media (max-width: 640px) {
    .live2d-plus-settings .mapping-row {
        grid-template-columns: 1fr;
        align-items: stretch;
    }
}
`;

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

function CheckboxRow({ label, checked, onChange }) {
    return (
        <label className="checkbox_label" style={{ marginBottom: '4px' }}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>{label}</span>
        </label>
    );
}

function Slider({ label, value, min, max, step, onChange, displayValue }) {
    const display = displayValue !== undefined ? displayValue : value;
    return (
        <div style={{ marginBottom: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                <small>{label}</small>
                <small style={{ opacity: 0.7 }}>{display}</small>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{ width: '100%' }}
            />
        </div>
    );
}

function formatNumber(value, digits = 2) {
    return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function ColorInput({ label, value, onChange }) {
    return (
        <div style={{ marginBottom: '8px' }}>
            <small style={{ display: 'block', marginBottom: '2px' }}>{label}</small>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                    type="color"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    style={{ width: '36px', height: '28px', cursor: 'pointer', border: 'none', background: 'none' }}
                />
                <input
                    type="text"
                    className="text_pole"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.9em' }}
                />
            </div>
        </div>
    );
}

// Uses ST's inline-drawer classes so ST's jQuery handles expand/collapse.
// Content starts hidden via ST's .inline-drawer-content { display: none } CSS rule.
function SubDrawer({ title, children }) {
    return (
        <div className="inline-drawer" style={{ marginTop: '6px' }}>
            <div className="inline-drawer-toggle inline-drawer-header" style={{ padding: '4px 0' }}>
                <b style={{ fontSize: '0.9em' }}>{title}</b>
                <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down" />
            </div>
            <div className="inline-drawer-content" style={{ paddingTop: '6px', paddingBottom: '2px' }}>
                {children}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Motion & Expression tester
// ---------------------------------------------------------------------------

function getMotionLabel(motion, index) {
    const raw = typeof motion === 'string'
        ? motion
        : motion?.File || motion?.file || motion?.name || motion?.Name || `Motion ${index + 1}`;
    return String(raw).replace(/\.(mtn|json)$/i, '');
}

function getExpressionLabel(expr, index) {
    if (typeof expr === 'string') return expr.replace(/\.(exp3?|json)$/i, '');
    return expr?.name || expr?.Name || expr?.File || expr?.file || `Expression ${index}`;
}

function MotionTestSection() {
    const [modelInfo, setModelInfo] = useState({ name: '', motions: {}, expressions: [], message: '' });
    const resetTimerRef = useRef(0);

    const clearTestReset = useCallback(() => {
        if (resetTimerRef.current && typeof window !== 'undefined') {
            window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = 0;
    }, []);

    const scheduleTestReset = useCallback((model, delayMs = DEFAULT_STATE_RESET_DELAY_MS) => {
        clearTestReset();
        if (!model) return;
        if (typeof window === 'undefined') {
            resetDynamicState(model);
            return;
        }

        const safeDelay = Math.min(Math.max(Number(delayMs) || 0, 0), 60000);
        resetTimerRef.current = window.setTimeout(() => {
            resetTimerRef.current = 0;
            resetDynamicState(model);
        }, safeDelay);
    }, [clearTestReset]);

    useEffect(() => clearTestReset, [clearTestReset]);

    const refresh = useCallback(() => {
        const model = window.live2dPlusModel;
        if (!model) {
            setModelInfo({ name: '', motions: {}, expressions: [], message: 'No Live2D model loaded yet.' });
            return;
        }

        const internalSettings = model.internalModel?.settings || {};
        const rawMotions = internalSettings.motions || model.internalModel?.motionManager?.definitions || {};
        const motions = {};
        for (const [group, list] of Object.entries(rawMotions)) {
            if (Array.isArray(list) && list.length > 0) motions[group] = list;
        }

        const expSource = internalSettings.expressions
            || model.internalModel?.motionManager?.expressionManager?.definitions
            || [];
        const expressions = Array.isArray(expSource)
            ? expSource
            : expSource && typeof expSource === 'object'
                ? Object.values(expSource).filter(Boolean)
                : [];

        const name = internalSettings.name || 'Active Model';
        const hasAny = Object.keys(motions).length > 0 || expressions.length > 0;
        setModelInfo({ name, motions, expressions, message: hasAny ? '' : 'No motions or expressions found.' });
    }, []);

    async function playMotion(group, index) {
        const model = window.live2dPlusModel;
        if (!model?.motion) return;

        const motionManager = getMotionManager(model);
        let resetHandled = false;
        let detachMotionFinish = () => {};

        const resetOnce = () => {
            if (resetHandled) return;
            resetHandled = true;
            detachMotionFinish();
            clearTestReset();
            resetDynamicState(model);
        };

        try {
            clearTestReset();
            stopModelMotionsOnly(model);

            if (motionManager?.on) {
                const handleMotionFinish = () => resetOnce();
                motionManager.on('motionFinish', handleMotionFinish);
                detachMotionFinish = () => {
                    try { motionManager.off?.('motionFinish', handleMotionFinish); } catch { /* noop */ }
                    try { motionManager.removeListener?.('motionFinish', handleMotionFinish); } catch { /* noop */ }
                };
            }

            let fallbackDelay = DEFAULT_STATE_RESET_DELAY_MS;
            try {
                const motion = await motionManager?.loadMotion?.(group, index);
                fallbackDelay = readMotionDurationMs(motion);
            } catch { /* use fallback */ }

            clearTestReset();
            if (typeof window === 'undefined') {
                resetOnce();
            } else {
                const safeDelay = Math.min(Math.max(Number(fallbackDelay) || 0, 0), 60000) + 250;
                resetTimerRef.current = window.setTimeout(resetOnce, safeDelay);
            }
            const result = model.motion(group, index, undefined, { volume: 0 });
            Promise.resolve(result)
                .then((started) => {
                    if (started === false) resetOnce();
                })
                .catch((err) => {
                    console.error('[Live2D+] Motion error:', err);
                    resetOnce();
                });
        } catch (err) {
            console.error('[Live2D+] Motion error:', err);
            resetOnce();
        }
    }

    function playExpression(index) {
        const model = window.live2dPlusModel;
        if (!model?.expression) return;

        try {
            clearTestReset();
            const result = model.expression(index);
            Promise.resolve(result)
                .catch((err) => console.error('[Live2D+] Expression error:', err))
                .finally(() => scheduleTestReset(model));
        } catch (err) {
            console.error('[Live2D+] Expression error:', err);
            scheduleTestReset(model);
        }
    }

    const btnStyle = { fontSize: '0.8em', padding: '2px 8px', marginBottom: '4px' };

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                {modelInfo.name && <small style={{ opacity: 0.6 }}>{modelInfo.name}</small>}
                <div className="menu_button" onClick={refresh} title="Load motions/expressions from active model">
                    <i className="fa-solid fa-rotate" style={{ marginRight: '4px' }} />
                    Refresh
                </div>
            </div>

            {modelInfo.message && (
                <small style={{ opacity: 0.6, display: 'block', marginBottom: '6px' }}>{modelInfo.message}</small>
            )}

            {modelInfo.expressions.length > 0 && (
                <div style={{ marginBottom: '10px' }}>
                    <small style={{ opacity: 0.7, display: 'block', marginBottom: '4px' }}>
                        <strong>Expressions</strong>
                    </small>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {modelInfo.expressions.map((expr, i) => (
                            <div key={i} className="menu_button" onClick={() => playExpression(i)} style={btnStyle}>
                                {getExpressionLabel(expr, i)}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {Object.entries(modelInfo.motions).map(([group, motions]) => (
                <div key={group} style={{ marginBottom: '8px' }}>
                    <small style={{ opacity: 0.7, display: 'block', marginBottom: '4px' }}>
                        <strong>{group.replace(/_/g, ' ')}</strong>
                    </small>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {motions.map((motion, i) => (
                            <div key={i} className="menu_button" onClick={() => playMotion(group, i)} style={btnStyle}>
                                {getMotionLabel(motion, i)}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function MappingSelect({ label, value, options, onChange }) {
    return (
        <label className="inline-control">
            <span>{label}</span>
            <select className="text_pole" value={value || ''} onChange={(event) => onChange(event.target.value)}>
                <option value="">None</option>
                {options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}

function DynamicSettingsSection({ settings, onChange }) {
    const [modelInfo, setModelInfo] = useState(() => window.live2dPlusModelInfo || readRuntimeModelInfo(window.live2dPlusModel));
    const [availableModels, setAvailableModels] = useState([]);
    const [modelFetchState, setModelFetchState] = useState({ loading: false, message: '' });

    useEffect(() => {
        const updateModelInfo = (event) => setModelInfo(event.detail || readRuntimeModelInfo(window.live2dPlusModel));
        window.addEventListener(LIVE2D_MODEL_INFO_EVENT, updateModelInfo);
        updateModelInfo({ detail: window.live2dPlusModelInfo || readRuntimeModelInfo(window.live2dPlusModel) });
        return () => window.removeEventListener(LIVE2D_MODEL_INFO_EVENT, updateModelInfo);
    }, []);

    const motionOptions = Object.entries(modelInfo?.motions || {}).flatMap(([groupName, motions]) => (
        motions.map((motion, index) => ({
            value: `${groupName}:${index}`,
            label: `${groupName} / ${getMotionLabel(motion, index)}`,
        }))
    ));
    const expressionOptions = (modelInfo?.expressions || []).map((expression, index) => ({
        value: String(index),
        label: getExpressionLabel(expression, index),
    }));

    const update = (patch) => onChange({ ...settings, ...patch });
    const updateDisable = (key, value) => update({ disableSettings: { ...settings.disableSettings, [key]: value } });
    const updateEmotionMapping = (emotion, patch) => update({
        emotionMappings: {
            ...settings.emotionMappings,
            [emotion]: { ...(settings.emotionMappings?.[emotion] || {}), ...patch },
        },
    });
    const updateActionMapping = (index, patch) => update({
        actionMappings: settings.actionMappings.map((action, actionIndex) => (
            actionIndex === index ? { ...action, ...patch } : action
        )),
    });
    const movePriority = (index, direction) => {
        const next = [...settings.priorityList];
        const target = index + direction;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        update({ priorityList: next.map((item, itemIndex) => ({ ...item, priority: next.length - itemIndex })) });
    };

    const addActionMapping = () => update({
        actionMappings: [
            ...settings.actionMappings,
            { id: `action-${Date.now()}`, description: '', motion: '', expression: '' },
        ],
    });

    const removeActionMapping = (index) => update({
        actionMappings: settings.actionMappings.filter((_, actionIndex) => actionIndex !== index),
    });

    const fetchModels = async () => {
        setModelFetchState({ loading: true, message: 'Fetching models...' });
        try {
            const models = await fetchOpenAiModels({ baseUrl: settings.analysisBaseUrl, apiKey: settings.analysisApiKey });
            setAvailableModels(models);
            if (models.length > 0 && !settings.analysisModel) update({ analysisModel: models[0].id });
            setModelFetchState({ loading: false, message: `${models.length} model${models.length === 1 ? '' : 's'} found.` });
        } catch (error) {
            setModelFetchState({ loading: false, message: error?.message || 'Failed to fetch models.' });
        }
    };

    return (
        <SubDrawer title="Dynamic Analysis" defaultOpen={false}>
            <CheckboxRow
                label="Route SillyTavern TTS to Live2D"
                checked={settings.routeTtsToLive2D}
                onChange={(value) => update({ routeTtsToLive2D: value })}
            />
            <CheckboxRow
                label="Prevent original SillyTavern playback"
                checked={settings.blockOriginalTtsPlayback}
                onChange={(value) => update({ blockOriginalTtsPlayback: value })}
            />
            <CheckboxRow
                label="Dynamic emotion/action mode"
                checked={settings.dynamicMode}
                onChange={(value) => update({ dynamicMode: value })}
            />
            <CheckboxRow
                label="Reset expression after playback"
                checked={settings.resetExpressionAfterPlayback}
                onChange={(value) => update({ resetExpressionAfterPlayback: value })}
            />

            <label className="field">
                <span>OpenAI-compatible URL</span>
                <input
                    className="text_pole"
                    type="url"
                    value={settings.analysisBaseUrl}
                    onChange={(event) => update({ analysisBaseUrl: event.target.value })}
                    placeholder="https://proxy.example.com/v1"
                />
            </label>
            <label className="field">
                <span>API key</span>
                <input
                    className="text_pole"
                    type="password"
                    value={settings.analysisApiKey}
                    onChange={(event) => update({ analysisApiKey: event.target.value })}
                    placeholder="Optional bearer token"
                />
            </label>
            <label className="field">
                <span>Analysis model</span>
                <div className="inline-actions">
                    <select
                        className="text_pole"
                        value={settings.analysisModel}
                        onChange={(event) => update({ analysisModel: event.target.value })}
                    >
                        <option value={settings.analysisModel}>{settings.analysisModel || 'Select a model'}</option>
                        {availableModels.map((model) => (
                            <option key={model.id} value={model.id}>{model.name || model.id}</option>
                        ))}
                    </select>
                    <button className="menu_button" type="button" onClick={fetchModels} disabled={modelFetchState.loading}>
                        {modelFetchState.loading ? 'Fetching...' : 'Fetch Models'}
                    </button>
                </div>
            </label>
            {modelFetchState.message && <div className="hint">{modelFetchState.message}</div>}

            <div className="section-caption">Disable cue sources</div>
            <CheckboxRow label="Emotion motions" checked={!settings.disableSettings.emotionMotions} onChange={(value) => updateDisable('emotionMotions', !value)} />
            <CheckboxRow label="Emotion expressions" checked={!settings.disableSettings.emotionExpressions} onChange={(value) => updateDisable('emotionExpressions', !value)} />
            <CheckboxRow label="Action motions" checked={!settings.disableSettings.actionMotions} onChange={(value) => updateDisable('actionMotions', !value)} />
            <CheckboxRow label="Action expressions" checked={!settings.disableSettings.actionExpressions} onChange={(value) => updateDisable('actionExpressions', !value)} />

            <div className="section-caption">Priority</div>
            <div className="mapping-list compact">
                {settings.priorityList.map((item, index) => (
                    <div className="mapping-row priority-row" key={`${item.type}-${item.target}`}>
                        <span>{item.label}</span>
                        <div className="row-actions">
                            <button className="menu_button" type="button" onClick={() => movePriority(index, -1)} disabled={index === 0}>Up</button>
                            <button className="menu_button" type="button" onClick={() => movePriority(index, 1)} disabled={index === settings.priorityList.length - 1}>Down</button>
                        </div>
                    </div>
                ))}
            </div>

            <div className="section-caption">Emotion mappings</div>
            <div className="mapping-list">
                {settings.emotionLabels.map((emotion) => {
                    const mapping = settings.emotionMappings?.[emotion] || {};
                    return (
                        <div className="mapping-row" key={emotion}>
                            <strong>{emotion}</strong>
                            <MappingSelect label="Motion" value={mapping.motion} options={motionOptions} onChange={(value) => updateEmotionMapping(emotion, { motion: value })} />
                            <MappingSelect label="Expression" value={mapping.expression} options={expressionOptions} onChange={(value) => updateEmotionMapping(emotion, { expression: value })} />
                        </div>
                    );
                })}
            </div>

            <div className="section-caption">Action mappings</div>
            <div className="mapping-list">
                {settings.actionMappings.map((action, index) => (
                    <div className="mapping-row" key={action.id || index}>
                        <label className="field compact-field">
                            <span>Action</span>
                            <input
                                className="text_pole"
                                type="text"
                                value={action.description || ''}
                                onChange={(event) => updateActionMapping(index, { description: event.target.value })}
                                placeholder="laughs, sighs, waves..."
                            />
                        </label>
                        <MappingSelect label="Motion" value={action.motion} options={motionOptions} onChange={(value) => updateActionMapping(index, { motion: value })} />
                        <MappingSelect label="Expression" value={action.expression} options={expressionOptions} onChange={(value) => updateActionMapping(index, { expression: value })} />
                        <button className="menu_button" type="button" onClick={() => removeActionMapping(index)}>Remove</button>
                    </div>
                ))}
            </div>
            <button className="menu_button" type="button" onClick={addActionMapping}>Add Action</button>
        </SubDrawer>
    );
}

function TapMessageInput({ value, onChange }) {
    return (
        <label className="field compact-field">
            <span>Message</span>
            <textarea
                className="text_pole"
                rows={2}
                value={value || ''}
                onChange={(event) => onChange(event.target.value)}
                placeholder="Optional user message"
            />
        </label>
    );
}

function TapInteractionsSection({ settings, onChange }) {
    const [modelInfo, setModelInfo] = useState(() => window.live2dPlusModelInfo || readRuntimeModelInfo(window.live2dPlusModel));

    useEffect(() => {
        const updateModelInfo = (event) => setModelInfo(event.detail || readRuntimeModelInfo(window.live2dPlusModel));
        window.addEventListener(LIVE2D_MODEL_INFO_EVENT, updateModelInfo);
        updateModelInfo({ detail: window.live2dPlusModelInfo || readRuntimeModelInfo(window.live2dPlusModel) });
        return () => window.removeEventListener(LIVE2D_MODEL_INFO_EVENT, updateModelInfo);
    }, []);

    const motionOptions = Object.entries(modelInfo?.motions || {}).flatMap(([groupName, motions]) => (
        motions.map((motion, index) => ({
            value: `${groupName}:${index}`,
            label: `${groupName} / ${getMotionLabel(motion, index)}`,
        }))
    ));
    const expressionOptions = (modelInfo?.expressions || []).map((expression, index) => ({
        value: String(index),
        label: getExpressionLabel(expression, index),
    }));
    const hitAreas = Array.isArray(modelInfo?.hitAreas) ? modelInfo.hitAreas : [];
    const tapInteractions = settings.tapInteractions || {};
    const defaultMapping = tapInteractions.defaultMapping || {};
    const hitAreaMappings = tapInteractions.hitAreaMappings || {};

    const updateTapInteractions = (patch) => onChange({
        ...settings,
        tapInteractions: { ...tapInteractions, ...patch },
    });
    const updateDefaultMapping = (patch) => updateTapInteractions({
        defaultMapping: { ...defaultMapping, ...patch },
    });
    const updateHitAreaMapping = (hitArea, patch) => {
        const current = hitAreaMappings[hitArea.id] || hitAreaMappings[hitArea.name] || {};
        updateTapInteractions({
            hitAreaMappings: {
                ...hitAreaMappings,
                [hitArea.id]: { ...current, ...patch },
            },
        });
    };

    const renderMappingRow = ({ id, name }, mapping, updateMapping) => (
        <div className="mapping-row tap-row" key={id}>
            <strong>{name}</strong>
            <MappingSelect label="Motion" value={mapping.motion} options={motionOptions} onChange={(value) => updateMapping({ motion: value })} />
            <MappingSelect label="Expression" value={mapping.expression} options={expressionOptions} onChange={(value) => updateMapping({ expression: value })} />
            <TapMessageInput value={mapping.message} onChange={(value) => updateMapping({ message: value })} />
        </div>
    );

    return (
        <SubDrawer title="Tap Interactions">
            <CheckboxRow
                label="Enable tap interactions"
                checked={tapInteractions.enabled !== false}
                onChange={(value) => updateTapInteractions({ enabled: value })}
            />
            <CheckboxRow
                label="Auto-send interaction"
                checked={!!tapInteractions.autoSend}
                onChange={(value) => updateTapInteractions({ autoSend: value })}
            />

            <div className="section-caption">Default tap</div>
            <div className="mapping-list compact">
                {renderMappingRow(
                    { id: 'default', name: 'Default' },
                    defaultMapping,
                    updateDefaultMapping,
                )}
            </div>

            <div className="section-caption">Hit areas</div>
            {hitAreas.length === 0 ? (
                <div className="hint">No hit areas found on the active model.</div>
            ) : (
                <div className="mapping-list">
                    {hitAreas.map((hitArea) => renderMappingRow(
                        hitArea,
                        hitAreaMappings[hitArea.id] || hitAreaMappings[hitArea.name] || {},
                        (patch) => updateHitAreaMapping(hitArea, patch),
                    ))}
                </div>
            )}
        </SubDrawer>
    );
}

// ---------------------------------------------------------------------------
// Dynamic Live2D playback helpers
// ---------------------------------------------------------------------------

const TTS_DYNAMIC_TIMESTAMPS_READY_EVENT = 'TTSDynamicTimestampsReady';
const LIVE2D_MODEL_INFO_EVENT = 'Live2DPlusModelInfoChanged';
const LIVE2D_MOTION_PRIORITY_FORCE = 3;
const DEFAULT_STATE_RESET_DELAY_MS = 1800;
const LIVE2D_PLUS_NO_IDLE_GROUP = '__live2dPlusNoIdleAfterPlayback__';
let sillyTavernScriptPromise = null;

function readNeutralEmotion(settings = {}) {
    const labels = Array.isArray(settings.emotionLabels) ? settings.emotionLabels : [];
    return labels.find((label) => String(label).toLowerCase() === 'neutral') || labels[0] || 'Neutral';
}

function normalizePlaybackSegments(detail, settings) {
    const source = Array.isArray(detail?.segments) && detail.segments.length > 0
        ? detail.segments
        : [{ emotion: readNeutralEmotion(settings), action: null, text: detail?.text || '' }];

    return source.map((segment) => ({
        emotion: typeof segment?.emotion === 'string' && segment.emotion.trim()
            ? segment.emotion.trim()
            : readNeutralEmotion(settings),
        action: typeof segment?.action === 'string' && segment.action.trim() ? segment.action.trim() : null,
        text: typeof segment?.text === 'string' ? segment.text : '',
        startTime: Number.isFinite(Number(segment?.startTime)) ? Number(segment.startTime) : null,
        endTime: Number.isFinite(Number(segment?.endTime)) ? Number(segment.endTime) : null,
        duration: Number.isFinite(Number(segment?.duration)) ? Number(segment.duration) : null,
    }));
}

function pickAlignment(detail) {
    return detail?.alignment || detail?.timestamps || detail?.normalizedAlignment || null;
}

function readAlignmentDuration(alignment) {
    const endTimes = Array.isArray(alignment?.character_end_times_seconds)
        ? alignment.character_end_times_seconds
        : [];
    const last = Number(endTimes[endTimes.length - 1]);
    return Number.isFinite(last) ? last : 0;
}

function distributeSegmentsByTextLength(segments, duration) {
    const totalChars = segments.reduce((count, segment) => count + Array.from(segment.text || '').length, 0);
    const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Number(duration)
        : Math.max(segments.length, 1);
    let cursor = 0;

    return segments.map((segment, index) => {
        if (segment.startTime != null && segment.endTime != null) {
            return { ...segment, duration: Math.max(0, segment.endTime - segment.startTime) };
        }

        const charCount = Array.from(segment.text || '').length || 1;
        const segmentDuration = totalChars > 0
            ? (charCount / totalChars) * safeDuration
            : safeDuration / Math.max(segments.length, 1);
        const startTime = cursor;
        const isLast = index === segments.length - 1;
        const endTime = isLast ? safeDuration : cursor + segmentDuration;
        cursor = endTime;
        return { ...segment, startTime, endTime, duration: Math.max(0, endTime - startTime) };
    });
}

function calculatePlaybackTimeline(detail, settings) {
    const segments = normalizePlaybackSegments(detail, settings);
    const alignment = pickAlignment(detail);
    const characters = Array.isArray(alignment?.characters) ? alignment.characters : [];
    const startTimes = Array.isArray(alignment?.character_start_times_seconds)
        ? alignment.character_start_times_seconds
        : [];
    const endTimes = Array.isArray(alignment?.character_end_times_seconds)
        ? alignment.character_end_times_seconds
        : [];
    const alignmentText = characters.join('');
    const segmentText = segments.map((segment) => segment.text).join('');

    if (characters.length > 0 && startTimes.length >= characters.length && endTimes.length >= characters.length && alignmentText === segmentText) {
        let charCursor = 0;
        return segments.map((segment) => {
            const charLength = Array.from(segment.text || '').length;
            const startIndex = charCursor;
            const endIndex = Math.max(startIndex, charCursor + charLength - 1);
            charCursor += charLength;
            const startTime = Number(startTimes[startIndex]) || 0;
            const endTime = Number(endTimes[endIndex]) || startTime;
            return { ...segment, startTime, endTime, duration: Math.max(0, endTime - startTime) };
        });
    }

    const duration = Number(detail?.duration) || readAlignmentDuration(alignment);
    return distributeSegmentsByTextLength(segments, duration);
}

function parseMotionValue(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text || text === 'null') return null;
    const separatorIndex = text.lastIndexOf(':');
    if (separatorIndex < 0) return null;
    const groupName = text.slice(0, separatorIndex);
    const motionIndex = Number.parseInt(text.slice(separatorIndex + 1), 10);
    if (!Number.isInteger(motionIndex) || motionIndex < 0) return null;
    return { groupName, motionIndex };
}

function resolveMotionLabel(model, motionValue) {
    const parsedMotion = parseMotionValue(motionValue);
    if (!parsedMotion) return '';
    const settings = model?.internalModel?.settings || {};
    const definitions = settings.motions || model?.internalModel?.motionManager?.definitions || {};
    const groupMotions = Array.isArray(definitions?.[parsedMotion.groupName]) ? definitions[parsedMotion.groupName] : [];
    const motion = groupMotions[parsedMotion.motionIndex];
    return getMotionLabel(motion, parsedMotion.motionIndex);
}

function resolveExpressionLabel(model, expressionValue) {
    const expressionIndex = Number.parseInt(expressionValue, 10);
    if (!Number.isInteger(expressionIndex)) return '';
    const settings = model?.internalModel?.settings || {};
    const source = settings.expressions || model?.internalModel?.motionManager?.expressionManager?.definitions || [];
    const expressions = Array.isArray(source)
        ? source
        : source && typeof source === 'object'
            ? Object.values(source).filter(Boolean)
            : [];
    return getExpressionLabel(expressions[expressionIndex], expressionIndex);
}

function resolveMappedCue(settings, segment) {
    const emotionKey = typeof segment?.emotion === 'string' ? segment.emotion.trim() : '';
    const actionKey = typeof segment?.action === 'string' ? segment.action.trim() : '';
    const emotionMapping = emotionKey ? settings.emotionMappings?.[emotionKey] : null;
    const actionMapping = actionKey && Array.isArray(settings.actionMappings)
        ? settings.actionMappings.find((action) => action.description === actionKey)
        : null;
    const disabled = settings.disableSettings || {};
    const priorityList = Array.isArray(settings.priorityList) ? settings.priorityList : [];
    let motion = '';
    let expression = '';

    for (const item of priorityList.slice().sort((left, right) => right.priority - left.priority)) {
        if (item.type === 'action' && item.target === 'motion' && !motion && !disabled.actionMotions) {
            const candidate = actionMapping?.motion || '';
            if (candidate && candidate !== 'null') motion = candidate;
        }
        if (item.type === 'emotion' && item.target === 'expression' && !expression && !disabled.emotionExpressions) {
            const candidate = emotionMapping?.expression || '';
            if (candidate) expression = candidate;
        }
        if (item.type === 'emotion' && item.target === 'motion' && !motion && !disabled.emotionMotions) {
            const candidate = emotionMapping?.motion || '';
            if (candidate && candidate !== 'null') motion = candidate;
        }
        if (item.type === 'action' && item.target === 'expression' && !expression && !disabled.actionExpressions) {
            const candidate = actionMapping?.expression || '';
            if (candidate) expression = candidate;
        }
    }

    return { motion, expression };
}

function getMotionManager(model) {
    return model?.internalModel?.motionManager || null;
}

function suppressIdleMotionRestart(model) {
    const state = getMotionManager(model)?.state;
    if (!state) return;

    try {
        state.setReservedIdle?.(LIVE2D_PLUS_NO_IDLE_GROUP, -1);
        return;
    } catch { /* noop */ }

    try {
        state.reservedIdleGroup = LIVE2D_PLUS_NO_IDLE_GROUP;
        state.reservedIdleIndex = -1;
    } catch { /* noop */ }
}

function stopModelMotionsOnly(model) {
    const motionManager = getMotionManager(model);
    try { model?.stopMotions?.(); } catch { /* noop */ }
    try { motionManager?.stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?._stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.queueManager?.stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.state?.reset?.(); } catch { /* noop */ }
    try { motionManager?.stopSpeaking?.(); } catch { /* noop */ }
    try { motionManager.playing = false; } catch { /* noop */ }
}

function resetModelExpression(model) {
    const expressionManager = model?.internalModel?.motionManager?.expressionManager;
    if (!expressionManager) return;

    try { expressionManager.reserveExpressionIndex = -1; } catch { /* noop */ }
    try { expressionManager.stopAllExpressions?.(); } catch { /* noop */ }
    try {
        if (expressionManager.defaultExpression) {
            expressionManager.currentExpression = expressionManager.defaultExpression;
        }
    } catch { /* noop */ }

    if (typeof expressionManager?.resetExpression === 'function') {
        try { expressionManager.resetExpression(); return; } catch { /* noop */ }
    }
    try { model?.expression?.(0); } catch { /* noop */ }
}

function readMotionDurationMs(motion, fallbackMs = DEFAULT_STATE_RESET_DELAY_MS) {
    const rawDuration = [
        motion?.duration,
        motion?._duration,
        typeof motion?.getDuration === 'function' ? motion.getDuration() : null,
    ]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value) && value > 0);

    if (!Number.isFinite(rawDuration)) return fallbackMs;
    const durationMs = rawDuration > 100 ? rawDuration : rawDuration * 1000;
    return Math.min(Math.max(Math.round(durationMs), 250), 60000);
}

function resetDynamicState(model, { suppressIdle = true } = {}) {
    stopModelMotionsOnly(model);
    resetModelExpression(model);
    if (suppressIdle) suppressIdleMotionRestart(model);
}

async function startMotionWithoutInterruptingAudio(model, parsedMotion, options = {}) {
    const motionManager = getMotionManager(model);
    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    if (!motionManager || typeof motionManager.loadMotion !== 'function' || typeof motionManager._startMotion !== 'function') {
        console.warn('[Live2D Dynamic] Motion manager cannot start a cue without interrupting audio.');
        return false;
    }

    const definitions = motionManager.definitions || {};
    const groupMotions = Array.isArray(definitions?.[parsedMotion.groupName]) ? definitions[parsedMotion.groupName] : [];
    if (!groupMotions[parsedMotion.motionIndex]) {
        console.warn('[Live2D Dynamic] Motion mapping points to an unavailable motion:', parsedMotion);
        return false;
    }

    if (!shouldContinue()) return false;

    try {
        stopModelMotionsOnly(model);
        if (!shouldContinue()) return false;
        if (typeof motionManager.state?.reserve === 'function') {
            const reserved = motionManager.state.reserve(parsedMotion.groupName, parsedMotion.motionIndex, LIVE2D_MOTION_PRIORITY_FORCE);
            if (!reserved) return false;
        }

        const motion = await motionManager.loadMotion(parsedMotion.groupName, parsedMotion.motionIndex);
        if (!motion || !shouldContinue()) return false;

        if (typeof motionManager.state?.start === 'function') {
            const started = motionManager.state.start(motion, parsedMotion.groupName, parsedMotion.motionIndex, LIVE2D_MOTION_PRIORITY_FORCE);
            if (!started) return false;
        }

        motionManager.playing = true;
        try { motionManager.emit?.('motionStart', parsedMotion.groupName, parsedMotion.motionIndex, null); } catch { /* noop */ }
        motionManager._startMotion(motion);
        return true;
    } catch (error) {
        console.error('[Live2D Dynamic] Motion failed:', error);
        return false;
    }
}

async function applyDynamicCue(model, settings, segment, options = {}) {
    if (!model) return null;
    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    const { motion, expression } = resolveMappedCue(settings, segment);
    const cue = {
        emotion: segment?.emotion || '',
        action: segment?.action || null,
        text: segment?.text || '',
        motion,
        motionLabel: resolveMotionLabel(model, motion),
        expression,
        expressionLabel: resolveExpressionLabel(model, expression),
        appliedMotion: false,
        appliedExpression: false,
    };

    if (!shouldContinue()) return cue;

    if (expression !== '') {
        const expressionIndex = Number.parseInt(expression, 10);
        if (Number.isInteger(expressionIndex)) {
            try {
                const result = model.expression?.(expressionIndex);
                cue.appliedExpression = await Promise.resolve(result).then((value) => shouldContinue() && value !== false);
            } catch (error) {
                console.error('[Live2D Dynamic] Expression failed:', error);
            }
        }
    }

    const parsedMotion = parseMotionValue(motion);
    if (parsedMotion) {
        cue.appliedMotion = await startMotionWithoutInterruptingAudio(model, parsedMotion, options);
    }

    return cue;
}

function getSillyTavernContext() {
    return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
        ? SillyTavern.getContext()
        : null;
}

function getSillyTavernScriptUrl() {
    if (typeof document !== 'undefined') {
        const script = document.querySelector('script[src$="/script.js"], script[src="script.js"], script[src="./script.js"]');
        if (script?.src) return script.src;
    }

    return '/script.js';
}

function loadSillyTavernScriptModule() {
    if (!sillyTavernScriptPromise) {
        sillyTavernScriptPromise = import(/* webpackIgnore: true */ getSillyTavernScriptUrl());
    }

    return sillyTavernScriptPromise;
}

function normalizeHitAreaNames(hitAreas) {
    return Array.isArray(hitAreas)
        ? hitAreas.map((hitArea) => String(hitArea || '').trim()).filter(Boolean)
        : [];
}

function hasTapMappingValue(mapping) {
    return !!(mapping?.motion || mapping?.expression || mapping?.message);
}

function readTapAreaMapping(tapInteractions, hitArea) {
    const mappings = tapInteractions?.hitAreaMappings || {};
    return mappings[hitArea.id] || mappings[hitArea.name] || {};
}

function resolveTapInteractionMapping(model, settings, hitAreas = []) {
    const tapInteractions = settings?.tapInteractions || {};
    const tappedAreas = new Set(normalizeHitAreaNames(hitAreas));
    const hitAreaDefinitions = normalizeRuntimeHitAreas(model?.internalModel?.hitAreas);
    const mappedHitArea = hitAreaDefinitions
        .filter((hitArea) => tappedAreas.has(hitArea.id) || tappedAreas.has(hitArea.name))
        .map((hitArea) => ({ hitArea, mapping: readTapAreaMapping(tapInteractions, hitArea) }))
        .filter(({ mapping }) => hasTapMappingValue(mapping))
        .sort((left, right) => left.hitArea.index - right.hitArea.index || left.hitArea.name.localeCompare(right.hitArea.name))[0];

    if (mappedHitArea) {
        return { ...mappedHitArea.mapping, hitArea: mappedHitArea.hitArea };
    }

    return { ...(tapInteractions.defaultMapping || {}), hitArea: null };
}

async function sendTapInteractionMessage(messageText, settings, previousInteractionRef) {
    const message = typeof messageText === 'string' ? messageText.trim() : '';
    if (!message) return false;

    const context = getSillyTavernContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const lastMessage = chat[chat.length - 1];
    if (lastMessage?.is_user && previousInteractionRef.current?.message === message) {
        console.debug('[Live2D+ Tap] Same interaction as latest user message; skipping duplicate send.');
        return false;
    }

    previousInteractionRef.current = { message };

    try { window.$?.('#send_textarea')?.val?.(''); } catch { /* noop */ }

    const scriptModule = await loadSillyTavernScriptModule();
    if (typeof scriptModule?.sendMessageAsUser !== 'function') {
        throw new Error('SillyTavern sendMessageAsUser is not available.');
    }

    await scriptModule.sendMessageAsUser(message);

    if (settings?.tapInteractions?.autoSend) {
        const liveContext = getSillyTavernContext();
        await liveContext?.generate?.();
    }

    return true;
}

async function playTapInteractionMotion(model, motionValue) {
    const parsedMotion = parseMotionValue(motionValue);
    if (!parsedMotion || !model?.motion) return false;

    try {
        const result = model.motion(parsedMotion.groupName, parsedMotion.motionIndex, undefined, { volume: 0 });
        return await Promise.resolve(result).then((value) => value !== false);
    } catch (error) {
        console.error('[Live2D+ Tap] Motion failed:', error);
        return false;
    }
}

async function playTapInteractionExpression(model, expressionValue) {
    const expressionIndex = Number.parseInt(expressionValue, 10);
    if (!Number.isInteger(expressionIndex) || !model?.expression) return false;

    try {
        const result = model.expression(expressionIndex);
        return await Promise.resolve(result).then((value) => value !== false);
    } catch (error) {
        console.error('[Live2D+ Tap] Expression failed:', error);
        return false;
    }
}

async function applyTapInteraction(model, settings, mapping, previousInteractionRef) {
    if (!model || !hasTapMappingValue(mapping)) return;

    try {
        await sendTapInteractionMessage(mapping.message, settings, previousInteractionRef);
    } catch (error) {
        console.error('[Live2D+ Tap] Message send failed:', error);
    }
    await playTapInteractionExpression(model, mapping.expression);
    await playTapInteractionMotion(model, mapping.motion);
}

function readPointerGlobalPoint(event) {
    const point = event?.global || event?.data?.global;
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function readPointerHitAreas(model, event) {
    const point = readPointerGlobalPoint(event);
    if (!point || typeof model?.hitTest !== 'function') return [];

    try {
        const hitAreas = await model.hitTest(point.x, point.y);
        return normalizeHitAreaNames(hitAreas);
    } catch (error) {
        console.error('[Live2D+ Tap] Hit test failed:', error);
        return [];
    }
}

async function decodePlaybackBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API is not available.');
    const ctx = new AudioCtx();
    try {
        return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
        try { ctx.close(); } catch { /* noop */ }
    }
}

function audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numChannels * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    let pos = 0;

    function setUint16(value) { view.setUint16(pos, value, true); pos += 2; }
    function setUint32(value) { view.setUint32(pos, value, true); pos += 4; }

    setUint32(0x46464952);
    setUint32(length - 8);
    setUint32(0x45564157);
    setUint32(0x20746d66);
    setUint32(16);
    setUint16(1);
    setUint16(numChannels);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numChannels);
    setUint16(numChannels * 2);
    setUint16(16);
    setUint32(0x61746164);
    setUint32(length - pos - 4);

    const channels = [];
    for (let channel = 0; channel < numChannels; channel += 1) channels.push(audioBuffer.getChannelData(channel));

    let offset = 0;
    while (pos < length) {
        for (let channel = 0; channel < numChannels; channel += 1) {
            let sample = Math.max(-1, Math.min(1, channels[channel][offset] || 0));
            sample = (sample < 0 ? sample * 32768 : sample * 32767) | 0;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset += 1;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function sliceAudioBufferToWavBlob(audioBuffer, startTime, endTime) {
    const sampleRate = audioBuffer.sampleRate;
    const totalFrames = audioBuffer.length;
    const startFrame = Math.max(0, Math.min(totalFrames, Math.floor(Number(startTime) * sampleRate)));
    const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil(Number(endTime) * sampleRate)));
    const frameCount = endFrame - startFrame;
    if (frameCount <= 0) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    try {
        const part = ctx.createBuffer(audioBuffer.numberOfChannels, frameCount, sampleRate);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
            const src = audioBuffer.getChannelData(channel);
            const dst = part.getChannelData(channel);
            for (let sample = 0; sample < frameCount; sample += 1) dst[sample] = src[startFrame + sample] || 0;
        }
        return audioBufferToWavBlob(part);
    } finally {
        try { ctx.close(); } catch { /* noop */ }
    }
}

async function buildSegmentAudioUrls(blobUrl, timeline) {
    if (!blobUrl || !Array.isArray(timeline) || timeline.length === 0) return [];
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    const audioBuffer = await decodePlaybackBlob(blob);
    const totalDuration = audioBuffer.duration;

    return timeline.map((segment, index) => {
        const rawStart = Number(segment.startTime);
        const rawEnd = Number(segment.endTime);
        const start = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
        const isLast = index === timeline.length - 1;
        let end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : totalDuration;
        if (isLast) end = totalDuration;
        const wavBlob = sliceAudioBufferToWavBlob(audioBuffer, start, end);
        if (!wavBlob) return { segment, url: null, start, end };
        return { segment, url: URL.createObjectURL(wavBlob), start, end };
    });
}

function normalizeRuntimeMotions(source) {
    const motions = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return Object.fromEntries(
        Object.entries(motions)
            .map(([groupName, groupMotions]) => [groupName, Array.isArray(groupMotions) ? groupMotions : []])
            .filter(([, groupMotions]) => groupMotions.length > 0)
    );
}

function normalizeRuntimeExpressions(source) {
    if (Array.isArray(source)) return source;
    if (Array.isArray(source?.definitions)) return source.definitions;
    if (source && typeof source === 'object') return Object.values(source).filter(Boolean);
    return [];
}

function normalizeRuntimeHitAreas(source) {
    const hitAreas = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return Object.entries(hitAreas)
        .map(([id, area]) => {
            const rawIndex = Number(area?.index);
            return {
                id: String(id),
                name: String(area?.name || id),
                index: Number.isFinite(rawIndex) ? rawIndex : 9999,
            };
        })
        .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
}

function readRuntimeModelInfo(model) {
    const internalSettings = model?.internalModel?.settings || {};
    return {
        name: internalSettings.name || 'Active Model',
        motions: normalizeRuntimeMotions(internalSettings.motions || model?.internalModel?.motionManager?.definitions),
        expressions: normalizeRuntimeExpressions(
            internalSettings.expressions || model?.internalModel?.motionManager?.expressionManager?.definitions
        ),
        hitAreas: normalizeRuntimeHitAreas(internalSettings.hitAreas || model?.internalModel?.hitAreas),
    };
}

function dispatchRuntimeModelInfo(model) {
    if (typeof window === 'undefined') return;
    const detail = readRuntimeModelInfo(model);
    window.live2dPlusModelInfo = detail;
    window.dispatchEvent(new CustomEvent(LIVE2D_MODEL_INFO_EVENT, { detail }));
    console.log('[Live2D+] Runtime model info:', detail);
}

// ---------------------------------------------------------------------------
// Live2D Canvas — rendered as a portal to document.body
// ---------------------------------------------------------------------------

function Live2DCanvas({ settings, onPositionCommit }) {
    const rootRef = useRef(null);
    const containerRef = useRef(null);
    const appRef = useRef(null);
    const modelRef = useRef(null);
    const rendererRef = useRef(null);
    const currentSettingsRef = useRef(settings);
    const dragStateRef = useRef(null);
    const activeLipsyncRef = useRef(null);
    const stateResetTimerRef = useRef(0);
    const captionControllerRef = useRef(null);
    const previousInteractionRef = useRef({ message: '' });
    const tapEventGuardRef = useRef({ key: '', time: 0 });
    const [status, setStatus] = useState({ state: 'loading', message: 'Initializing...' });
    const [pos, setPos] = useState({ x: settings.positionX, y: settings.positionY });

    useEffect(() => {
        currentSettingsRef.current = settings;
    }, [settings]);

    const clearPendingStateReset = useCallback(() => {
        if (stateResetTimerRef.current && typeof window !== 'undefined') {
            window.clearTimeout(stateResetTimerRef.current);
        }
        stateResetTimerRef.current = 0;
    }, []);

    const resetModelStateAfterPlayback = useCallback((model = modelRef.current) => {
        clearPendingStateReset();
        const liveSettings = currentSettingsRef.current;
        if (!model || liveSettings?.resetExpressionAfterPlayback === false) return;
        resetDynamicState(model);
    }, [clearPendingStateReset]);

    const stopActiveLipsync = useCallback(() => {
        activeLipsyncRef.current?.stop?.();
        activeLipsyncRef.current = null;
        captionControllerRef.current?.clear();
        resetModelStateAfterPlayback();
    }, [resetModelStateAfterPlayback]);

    useEffect(() => clearPendingStateReset, [clearPendingStateReset]);

    useEffect(() => {
        const controller = createLive2DCaptionController(rootRef.current);
        captionControllerRef.current = controller;
        controller?.updateSettings(settings);
        return () => {
            controller?.destroy();
            captionControllerRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        captionControllerRef.current?.updateSettings(settings);
    }, [settings]);

    // Sync position from settings when not dragging
    useEffect(() => {
        if (!dragStateRef.current) {
            setPos({ x: settings.positionX, y: settings.positionY });
        }
    }, [settings.positionX, settings.positionY]);

    // Apply filters to active model
    const applyFilters = useCallback((s) => {
        const model = modelRef.current;
        const PIXI = rendererRef.current?.PIXI || window.PIXI;
        if (!model || !PIXI) return;
        const filters = buildFilters(s, PIXI);
        model.filters = filters.length > 0 ? filters : null;
    }, []);

    const handleTapAreas = useCallback((hitAreas = []) => {
        const model = modelRef.current;
        const liveSettings = currentSettingsRef.current || settings;
        if (!model || liveSettings?.tapInteractions?.enabled === false) return;

        const normalizedHitAreas = normalizeHitAreaNames(hitAreas);
        const key = normalizedHitAreas.slice().sort().join('|') || '__default__';
        const now = Date.now();
        const lastEvent = tapEventGuardRef.current;
        if (lastEvent.key === key && now - lastEvent.time < 150) return;
        tapEventGuardRef.current = { key, time: now };

        const mapping = resolveTapInteractionMapping(model, liveSettings, normalizedHitAreas);
        if (!hasTapMappingValue(mapping)) return;

        console.debug('[Live2D+ Tap] Interaction:', {
            hitAreas: normalizedHitAreas,
            selectedHitArea: mapping.hitArea?.name || 'default',
            motion: mapping.motion || '',
            expression: mapping.expression || '',
            hasMessage: !!mapping.message,
        });

        applyTapInteraction(model, liveSettings, mapping, previousInteractionRef)
            .catch((error) => console.error('[Live2D+ Tap] Interaction failed:', error));
    }, [settings]);

    const attachTapInteractionHandlers = useCallback((model) => {
        if (!model || typeof model.on !== 'function') return () => {};

        const handleHit = (hitAreas) => handleTapAreas(hitAreas);
        const handlePointerTap = (event) => {
            readPointerHitAreas(model, event)
                .then(handleTapAreas)
                .catch((error) => console.error('[Live2D+ Tap] Pointer tap failed:', error));
        };

        model.on('hit', handleHit);
        model.on('pointertap', handlePointerTap);
        model.on('click', handlePointerTap);

        return () => {
            try { model.off?.('hit', handleHit); } catch { /* noop */ }
            try { model.off?.('pointertap', handlePointerTap); } catch { /* noop */ }
            try { model.off?.('click', handlePointerTap); } catch { /* noop */ }
        };
    }, [handleTapAreas]);

    // Model load effect
    const modelUrl = resolveModelUrl(settings);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !modelUrl) {
            if (!modelUrl) setStatus({ state: 'error', message: 'No model URL configured.' });
            return;
        }

        let cancelled = false;

        function destroyCurrent() {
            if (modelRef.current) {
                try { modelRef.current.__live2dPlusTapCleanup?.(); } catch (_) { /* noop */ }
                try { modelRef.current.destroy?.(); } catch (_) { /* noop */ }
                modelRef.current = null;
                window.live2dPlusModel = null;
            }
            if (appRef.current) {
                try { appRef.current.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (_) { /* noop */ }
                appRef.current = null;
            }
        }

        destroyCurrent();
        setStatus({ state: 'loading', message: 'Loading model...' });

        (async () => {
            try {
                const runtime = await loadLive2DRuntime();
                if (cancelled) return;

                const { PIXI, Live2DModel } = runtime;
                rendererRef.current = runtime;

                const app = new PIXI.Application({
                    transparent: true,
                    backgroundAlpha: 0,
                    autoStart: true,
                    width: settings.canvasWidth,
                    height: settings.canvasHeight,
                });
                app.stage.eventMode = 'static';
                app.stage.hitArea = app.screen;
                appRef.current = app;

                // PIXI owns its own canvas; we append it to a container div.
                // This lets us fully destroy/recreate the canvas (and its WebGL
                // context) on model reloads without touching React's DOM, and
                // avoids leaking WebGL contexts on size changes (see resize effect).
                const view = app.view;
                view.style.display = 'block';
                view.style.width = '100%';
                view.style.height = '100%';
                view.style.pointerEvents =
                    settings.enableHitTesting || settings.followCursor || settings.tapInteractions?.enabled ? 'auto' : 'none';
                container.appendChild(view);

                const model = Live2DModel.fromSync(modelUrl, {
                    autoFocus: !!settings.followCursor,
                    autoHitTest: !!settings.enableHitTesting || !!settings.tapInteractions?.enabled,
                });

                if (cancelled) { model.destroy?.(); return; }
                modelRef.current = model;

                model.once('load', () => {
                    if (cancelled) { model.destroy?.(); return; }
                    app.stage.addChild(model);
                    model.alpha = settings.opacity;
                    applyModelTransform(model, settings);
                    applyModelInteraction(model, settings);
                    muteModelMotionAudio(model);
                    applyFilters(settings);
                    model.__live2dPlusTapCleanup = attachTapInteractionHandlers(model);
                    window.live2dPlusModel = model;
                    dispatchRuntimeModelInfo(model);
                    setStatus({ state: 'ready', message: 'Ready' });
                });

                model.once?.('error', (err) => {
                    if (cancelled) return;
                    destroyCurrent();
                    setStatus({ state: 'error', message: err?.message || 'Failed to load model.' });
                });
            } catch (err) {
                if (cancelled) return;
                destroyCurrent();
                setStatus({ state: 'error', message: err?.message || 'Failed to load runtime.' });
            }
        })();

        return () => {
            cancelled = true;
            destroyCurrent();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelUrl, settings.reloadKey]);

    // Canvas resize effect — resize the renderer in place instead of
    // destroying/recreating the whole PIXI app (which leaked WebGL contexts
    // and eventually stopped rendering entirely).
    useEffect(() => {
        const app = appRef.current;
        if (app?.renderer) {
            app.renderer.resize(settings.canvasWidth, settings.canvasHeight);
            app.stage.hitArea = app.screen;
            applyModelTransform(modelRef.current, settings);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.canvasWidth, settings.canvasHeight]);

    // Transform effect
    useEffect(() => {
        applyModelTransform(modelRef.current, settings);
    }, [settings.scale, settings.modelPositionX, settings.modelPositionY, settings.canvasWidth, settings.canvasHeight]);

    // Interaction effect
    useEffect(() => {
        applyModelInteraction(modelRef.current, settings);
        const view = appRef.current?.view;
        if (view?.style) {
            view.style.pointerEvents =
                settings.enableHitTesting || settings.followCursor || settings.tapInteractions?.enabled ? 'auto' : 'none';
        }
    }, [settings.followCursor, settings.enableHitTesting, settings.tapInteractions?.enabled]);

    // Filters effect
    const filtersKey = JSON.stringify({ f: settings.filters, p: settings.filterParams });
    useEffect(() => {
        applyFilters(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applyFilters, filtersKey]);

    // Opacity effect
    useEffect(() => {
        if (modelRef.current) modelRef.current.alpha = settings.opacity;
    }, [settings.opacity]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;

        const handleDynamicTimestampsReady = (event) => {
            const detail = event.detail || {};
            const liveSettings = currentSettingsRef.current || settings;
            console.log('[Live2D+ Dynamic] Event received:', {
                routeTtsToLive2D: liveSettings.routeTtsToLive2D,
                dynamicMode: liveSettings.dynamicMode,
                hasBlobUrl: !!detail.blobUrl,
                text: detail.text || '',
                segments: detail.segments || [],
                approximate: detail.approximate === true,
            });

            if (!liveSettings.routeTtsToLive2D || !detail.blobUrl) return;

            const model = modelRef.current;
            if (!model?.speak) {
                console.warn('[Live2D+ Dynamic] Model is not ready for playback.');
                return;
            }

            detail.accepted = true;

            stopActiveLipsync();

            let settled = false;
            const segmentUrls = [];
            const timeline = calculatePlaybackTimeline(detail, liveSettings);
            const releaseSegmentUrls = () => {
                while (segmentUrls.length) {
                    const url = segmentUrls.pop();
                    if (url) {
                        try { URL.revokeObjectURL(url); } catch { /* noop */ }
                    }
                }
            };
            const cleanup = ({ reset = false } = {}) => {
                detail.signal?.removeEventListener?.('abort', handleAbort);
                if (reset) resetModelStateAfterPlayback(model);
                releaseSegmentUrls();
                if (detail.blobUrl) {
                    try { URL.revokeObjectURL(detail.blobUrl); } catch { /* noop */ }
                    detail.blobUrl = '';
                }
                if (activeLipsyncRef.current?.finish === finish) activeLipsyncRef.current = null;
            };
            const finish = () => {
                if (settled) return;
                console.log('[Live2D+ Dynamic] Playback finished.');
                settled = true;
                captionControllerRef.current?.finish();
                cleanup({ reset: true });
                detail.resolve?.();
            };
            const fail = (error) => {
                if (settled) return;
                console.error('[Live2D+ Dynamic] Playback failed:', error);
                settled = true;
                captionControllerRef.current?.clear();
                cleanup({ reset: true });
                detail.reject?.(error);
            };
            const stop = () => {
                if (settled) return;
                console.log('[Live2D+ Dynamic] Playback stopped.');
                try { model.stopSpeaking?.(); } catch { /* noop */ }
                finish();
            };
            const handleAbort = () => stop();

            if (detail.signal?.aborted) {
                finish();
                return;
            }

            activeLipsyncRef.current = { finish, fail, stop };
            detail.signal?.addEventListener?.('abort', handleAbort, { once: true });
            console.log('[Live2D+ Dynamic] Playback timeline:', timeline);

            const playSegmentsSequentially = async () => {
                const sliced = await buildSegmentAudioUrls(detail.blobUrl, timeline);
                if (settled) return;
                for (const item of sliced) {
                    if (item?.url) segmentUrls.push(item.url);
                }

                for (let index = 0; index < sliced.length; index += 1) {
                    if (settled) return;
                    const { segment, url, start, end } = sliced[index];
                    console.log(`[Live2D+ Dynamic] Playing segment ${index + 1}/${sliced.length}:`, {
                        emotion: segment?.emotion || '',
                        action: segment?.action || null,
                        start,
                        end,
                        text: segment?.text || '',
                        hasAudio: !!url,
                    });

                    const durationMs = Math.max(350, Math.round(Math.max(0, (end || 0) - (start || 0)) * 1000));
                    captionControllerRef.current?.start({ text: segment?.text || '', durationMs });

                    applyDynamicCue(model, liveSettings, segment, { shouldContinue: () => !settled })
                        .then((cue) => {
                            if (!settled) console.log('[Live2D+ Dynamic] Applied cue:', { segment, cue });
                        })
                        .catch((error) => console.error('[Live2D+ Dynamic] Cue application failed:', error));

                    if (!url) continue;

                    await new Promise((resolveSegment) => {
                        let segmentResolved = false;
                        const fallbackTimer = typeof window !== 'undefined'
                            ? window.setTimeout(() => {
                                console.warn(`[Live2D+ Dynamic] Segment ${index + 1} finish callback timed out; continuing to final reset.`);
                                resolveOnce();
                            }, Math.max(durationMs + 1500, 3000))
                            : 0;
                        const resolveOnce = () => {
                            if (segmentResolved) return;
                            segmentResolved = true;
                            if (fallbackTimer && typeof window !== 'undefined') window.clearTimeout(fallbackTimer);
                            resolveSegment();
                        };

                        try { model.stopSpeaking?.(); } catch { /* noop */ }
                        try {
                            const result = model.speak(url, {
                                volume: 0.7,
                                crossOrigin: 'anonymous',
                                onFinish: () => {
                                    console.log(`[Live2D+ Dynamic] Segment ${index + 1} finished.`);
                                    resolveOnce();
                                },
                                onError: (error) => {
                                    console.error(`[Live2D+ Dynamic] Segment ${index + 1} error:`, error);
                                    resolveOnce();
                                },
                            });

                            Promise.resolve(result)
                                .then((started) => {
                                    if (started === false) {
                                        console.warn(`[Live2D+ Dynamic] Segment ${index + 1} rejected by model.speak.`);
                                        resolveOnce();
                                    }
                                })
                                .catch((error) => {
                                    console.error(`[Live2D+ Dynamic] Segment ${index + 1} start failed:`, error);
                                    resolveOnce();
                                });
                        } catch (error) {
                            console.error(`[Live2D+ Dynamic] Segment ${index + 1} threw:`, error);
                            resolveOnce();
                        }
                    });
                }

                if (!settled) finish();
            };

            playSegmentsSequentially().catch(fail);
        };

        window.addEventListener(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, handleDynamicTimestampsReady);
        return () => window.removeEventListener(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, handleDynamicTimestampsReady);
    }, [settings, resetModelStateAfterPlayback, stopActiveLipsync]);

    // Drag handlers
    const onPointerDown = useCallback((e) => {
        if (!settings.draggable) return;
        e.preventDefault();
        e.stopPropagation();
        dragStateRef.current = {
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startX: pos.x,
            startY: pos.y,
        };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    }, [settings.draggable, pos.x, pos.y]);

    const onPointerMove = useCallback((e) => {
        const ds = dragStateRef.current;
        if (!ds || ds.pointerId !== e.pointerId) return;
        const dx = ((e.clientX - ds.startClientX) / Math.max(window.innerWidth, 1)) * 100;
        const dy = ((e.clientY - ds.startClientY) / Math.max(window.innerHeight, 1)) * 100;
        setPos({
            x: Math.min(100, Math.max(0, ds.startX + dx)),
            y: Math.min(100, Math.max(0, ds.startY + dy)),
        });
    }, []);

    const onPointerUp = useCallback((e) => {
        const ds = dragStateRef.current;
        if (!ds || ds.pointerId !== e.pointerId) return;
        dragStateRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setPos((latest) => {
            onPositionCommit?.({
                positionX: Number(latest.x.toFixed(2)),
                positionY: Number(latest.y.toFixed(2)),
            });
            return latest;
        });
    }, [onPositionCommit]);

    const wrapperStyle = {
        position: 'fixed',
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        width: `${settings.canvasWidth}px`,
        height: `${settings.canvasHeight}px`,
        transform: 'translate(-50%, -50%)',
        zIndex: settings.zIndex,
        pointerEvents: 'none',
    };

    return (
        <div ref={rootRef} style={wrapperStyle} data-live2dplus-root="true">
            <div
                ref={containerRef}
                style={{ display: 'block', width: '100%', height: '100%' }}
            />

            {status.state !== 'ready' && (
                <div style={{
                    position: 'absolute', bottom: 6, left: 6,
                    background: 'rgba(0,0,0,0.55)',
                    color: status.state === 'error' ? '#f87171' : '#c4b5fd',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: '0.75em',
                    pointerEvents: 'none',
                }}>
                    {status.message}
                </div>
            )}

            {settings.draggable && (
                <button
                    type="button"
                    aria-label="Move Live2D model"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    style={{
                        position: 'absolute',
                        right: 6, top: 6,
                        width: 30, height: 30,
                        borderRadius: '50%',
                        border: '1px solid rgba(255,255,255,0.2)',
                        background: 'rgba(0,0,0,0.45)',
                        color: 'rgba(255,255,255,0.75)',
                        cursor: 'grab',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'auto',
                    }}
                >
                    <i className="fa-solid fa-arrows-up-down-left-right" style={{ fontSize: 12 }} />
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App({ settings, onChange, sttModel, onLoadSttModel }) {
    const s = normalizeSettings(settings);
    const sttModelState = sttModel || { state: 'idle', message: '' };

    const set = (patch) => onChange(patch);

    const setFilter = (id, enabled) => set({ filters: { ...s.filters, [id]: enabled } });

    const setFilterParam = (id, patch) => set({
        filterParams: {
            ...s.filterParams,
            [id]: { ...s.filterParams[id], ...patch },
        },
    });

    const setCaption = (patch) => set({ captions: { ...s.captions, ...patch } });

    const handleReload = () => set({ reloadKey: s.reloadKey + 1 });

    // Rendered canvas portal (only when enabled)
    const canvasPortal = s.enabled && typeof document !== 'undefined'
        ? createPortal(
            <Live2DCanvas settings={s} onPositionCommit={(pos) => set(pos)} />,
            document.body
        )
        : null;

    return (
        <>
            <style>{LIVE2D_PLUS_SETTINGS_STYLES}</style>
            {/* ── Main settings drawer ── */}
            <div className="inline-drawer live2d-plus-settings">
                <div className="inline-drawer-toggle inline-drawer-header">
                    <b>Live2D+</b>
                    <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down" />
                </div>
                <div className="inline-drawer-content">

                    {/* ── Global ── */}
                    <CheckboxRow label="Enable Live2D" checked={s.enabled} onChange={(v) => set({ enabled: v })} />
                    <CheckboxRow label="Follow Cursor" checked={s.followCursor} onChange={(v) => set({ followCursor: v })} />
                    <CheckboxRow label="Enable Dragging" checked={s.draggable} onChange={(v) => set({ draggable: v })} />
                    <CheckboxRow label="Enable Hit Testing" checked={s.enableHitTesting} onChange={(v) => set({ enableHitTesting: v })} />

                    {/* ── Speech-to-Text (lip-sync) ── */}
                    <SubDrawer title="Speech-to-Text (Vosk)">
                        <CheckboxRow
                            label="Enable STT timestamps"
                            checked={s.sttEnabled}
                            onChange={(v) => set({ sttEnabled: v })}
                        />
                        <small style={{ opacity: 0.55, display: 'block', marginBottom: '6px' }}>
                            Intercepts TTS audio, transcribes it with Vosk, and logs word-level
                            timestamps to the browser console.
                        </small>
                        <div>
                            <small style={{ display: 'block', marginBottom: '4px' }}>Vosk model URL</small>
                            <input
                                type="text"
                                className="text_pole"
                                placeholder={`${EXTENSION_WEB_PATH}/models/…tar.gz`}
                                value={s.voskModelUrl}
                                onChange={(e) => set({ voskModelUrl: e.target.value })}
                                style={{ width: '100%', marginBottom: '4px' }}
                            />
                            <small style={{ opacity: 0.5 }}>
                                Leave empty to use the bundled default model. Drop your own
                                <code> .tar.gz </code> models in the extension's <code>models/</code> folder.
                                The path must be one SillyTavern can serve (e.g.
                                <code>/scripts/extensions/third-party/&lt;folder&gt;/models/…tar.gz</code>);
                                local Android document paths are converted automatically when possible.
                            </small>
                        </div>

                        <div
                            className="menu_button"
                            onClick={() => onLoadSttModel?.()}
                            style={{
                                marginTop: '8px',
                                textAlign: 'center',
                                opacity: sttModelState.state === 'loading' ? 0.6 : 1,
                                pointerEvents: sttModelState.state === 'loading' ? 'none' : 'auto',
                            }}
                        >
                            <i
                                className={
                                    sttModelState.state === 'loading'
                                        ? 'fa-solid fa-spinner fa-spin'
                                        : 'fa-solid fa-download'
                                }
                                style={{ marginRight: '6px' }}
                            />
                            {sttModelState.state === 'ready' ? 'Reload Vosk model' : 'Load Vosk model'}
                        </div>
                        {sttModelState.message && (
                            <small
                                style={{
                                    display: 'block',
                                    marginTop: '4px',
                                    color: sttModelState.state === 'error' ? '#f87171'
                                        : sttModelState.state === 'ready' ? '#4ade80' : 'inherit',
                                    opacity: sttModelState.state === 'error' || sttModelState.state === 'ready' ? 1 : 0.6,
                                    wordBreak: 'break-all',
                                }}
                            >
                                {sttModelState.message}
                            </small>
                        )}
                        <small style={{ opacity: 0.55, display: 'block', marginTop: '6px' }}>
                            You must load a model before TTS audio can be transcribed.
                        </small>
                    </SubDrawer>

                    <DynamicSettingsSection settings={s} onChange={set} />

                    <TapInteractionsSection settings={s} onChange={set} />

                    {/* -- Captions -- */}
                    <SubDrawer title="Captions">
                        <CheckboxRow
                            label="Enable captions"
                            checked={s.captions.enabled}
                            onChange={(v) => setCaption({ enabled: v })}
                        />
                        <small style={{ opacity: 0.55, display: 'block', marginBottom: '6px' }}>
                            Captions render over the Live2D overlay while routed TTS segments play.
                        </small>
                        {!s.routeTtsToLive2D && (
                            <small style={{ opacity: 0.65, display: 'block', marginBottom: '6px', color: '#fbbf24' }}>
                                Turn on Live2D TTS routing in Dynamic Analysis to show captions during playback.
                            </small>
                        )}

                        <label className="field">
                            <span>Caption Style</span>
                            <select
                                className="text_pole"
                                value={s.captions.style}
                                onChange={(event) => setCaption({ style: event.target.value })}
                            >
                                {CAPTION_STYLE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </label>

                        <ColorInput label="Base Color" value={s.captions.textColor} onChange={(v) => setCaption({ textColor: v })} />
                        <ColorInput label="Fill Color" value={s.captions.fillColor} onChange={(v) => setCaption({ fillColor: v })} />
                        <ColorInput label="Shadow Color" value={s.captions.shadowColor} onChange={(v) => setCaption({ shadowColor: v })} />

                        <Slider label="Font Size" value={s.captions.fontSize} min={18} max={96} step={1}
                            onChange={(v) => setCaption({ fontSize: v })} displayValue={`${Math.round(s.captions.fontSize)}px`} />
                        <Slider label="Font Weight" value={s.captions.fontWeight} min={400} max={900} step={100}
                            onChange={(v) => setCaption({ fontWeight: v })} displayValue={Math.round(s.captions.fontWeight)} />
                        <Slider label="Letter Spacing" value={s.captions.letterSpacing} min={-0.04} max={0.24} step={0.01}
                            onChange={(v) => setCaption({ letterSpacing: v })} displayValue={`${formatNumber(s.captions.letterSpacing, 2)}em`} />
                        <Slider label="Line Height" value={s.captions.lineHeight} min={0.8} max={1.8} step={0.02}
                            onChange={(v) => setCaption({ lineHeight: v })} displayValue={formatNumber(s.captions.lineHeight, 2)} />
                        <Slider label="Bottom Offset" value={s.captions.bottomOffset} min={0} max={120} step={1}
                            onChange={(v) => setCaption({ bottomOffset: v })} displayValue={`${Math.round(s.captions.bottomOffset)}px`} />
                        <Slider label="Max Width" value={s.captions.maxWidth} min={30} max={100} step={1}
                            onChange={(v) => setCaption({ maxWidth: v })} displayValue={`${Math.round(s.captions.maxWidth)}%`} />

                        <label className="field">
                            <span>Custom CSS</span>
                            <textarea
                                className="text_pole"
                                rows={5}
                                value={s.captions.customCss}
                                onChange={(event) => setCaption({ customCss: event.target.value })}
                                placeholder={'transform: translateY(-4px);\nfilter: drop-shadow(0 0 14px rgba(255, 155, 113, 0.35));'}
                                style={{ width: '100%', resize: 'vertical' }}
                            />
                        </label>
                    </SubDrawer>

                    {/* ── Model ── */}
                    <SubDrawer title="Model">
                        <div style={{ marginBottom: '6px' }}>
                            <small style={{ display: 'block', marginBottom: '4px' }}>Source</small>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {[
                                    { value: MODEL_SOURCES.DEFAULT, label: 'Default' },
                                    { value: MODEL_SOURCES.URL, label: 'URL' },
                                    { value: MODEL_SOURCES.LOCAL, label: 'Local' },
                                ].map(({ value, label }) => (
                                    <div
                                        key={value}
                                        className="menu_button"
                                        onClick={() => set({ modelSource: value })}
                                        style={{
                                            flex: 1,
                                            textAlign: 'center',
                                            fontWeight: s.modelSource === value ? 'bold' : 'normal',
                                            opacity: s.modelSource === value ? 1 : 0.6,
                                        }}
                                    >
                                        {label}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {s.modelSource === MODEL_SOURCES.DEFAULT && (
                            <small style={{ opacity: 0.55, display: 'block' }}>
                                Using Shizuku demo model (CDN).
                            </small>
                        )}

                        {s.modelSource === MODEL_SOURCES.URL && (
                            <div>
                                <small style={{ display: 'block', marginBottom: '4px' }}>Model URL</small>
                                <input
                                    type="text"
                                    className="text_pole"
                                    placeholder="https://..."
                                    value={s.customModelUrl}
                                    onChange={(e) => set({ customModelUrl: e.target.value })}
                                    style={{ width: '100%', marginBottom: '4px' }}
                                />
                            </div>
                        )}

                        {s.modelSource === MODEL_SOURCES.LOCAL && (
                            <div>
                                <small style={{ display: 'block', marginBottom: '4px' }}>Local path (served by ST)</small>
                                <input
                                    type="text"
                                    className="text_pole"
                                    placeholder="/user/images/live2d/Model/model3.json"
                                    value={s.localModelPath}
                                    onChange={(e) => set({ localModelPath: e.target.value })}
                                    style={{ width: '100%', marginBottom: '4px' }}
                                />
                                <small style={{ opacity: 0.5 }}>Path relative to the SillyTavern server root.</small>
                            </div>
                        )}

                        <div
                            className="menu_button"
                            onClick={handleReload}
                            style={{ marginTop: '8px', width: '100%', textAlign: 'center' }}
                        >
                            <i className="fa-solid fa-rotate-right" style={{ marginRight: '4px' }} />
                            Reload Model
                        </div>
                    </SubDrawer>

                    {/* ── Rendering ── */}
                    <SubDrawer title="Rendering">
                        <Slider label="Canvas Width" value={s.canvasWidth} min={200} max={2000} step={50}
                            onChange={(v) => set({ canvasWidth: v })} displayValue={`${s.canvasWidth}px`} />
                        <Slider label="Canvas Height" value={s.canvasHeight} min={200} max={2000} step={50}
                            onChange={(v) => set({ canvasHeight: v })} displayValue={`${s.canvasHeight}px`} />
                        <Slider label="Scale" value={s.scale} min={0.1} max={5} step={0.05}
                            onChange={(v) => set({ scale: v })} displayValue={s.scale.toFixed(2)} />
                        <Slider label="Screen Position X" value={s.positionX} min={0} max={100} step={1}
                            onChange={(v) => set({ positionX: v })} displayValue={`${s.positionX}%`} />
                        <Slider label="Screen Position Y" value={s.positionY} min={0} max={100} step={1}
                            onChange={(v) => set({ positionY: v })} displayValue={`${s.positionY}%`} />
                        <Slider label="Model Anchor X" value={s.modelPositionX} min={0} max={100} step={1}
                            onChange={(v) => set({ modelPositionX: v })} displayValue={`${s.modelPositionX}%`} />
                        <Slider label="Model Anchor Y" value={s.modelPositionY} min={0} max={100} step={1}
                            onChange={(v) => set({ modelPositionY: v })} displayValue={`${s.modelPositionY}%`} />
                        <Slider label="Opacity" value={s.opacity} min={0} max={1} step={0.05}
                            onChange={(v) => set({ opacity: v })} displayValue={s.opacity.toFixed(2)} />
                        <Slider label="Z-Index" value={s.zIndex} min={1} max={9999} step={1}
                            onChange={(v) => set({ zIndex: v })} />
                    </SubDrawer>

                    {/* ── Filters ── */}
                    <SubDrawer title="Filters">

                        <CheckboxRow label="Outline" checked={s.filters.outline} onChange={(v) => setFilter('outline', v)} />
                        {s.filters.outline && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Thickness" value={s.filterParams.outline.thickness} min={0} max={20} step={0.5}
                                    onChange={(v) => setFilterParam('outline', { thickness: v })}
                                    displayValue={s.filterParams.outline.thickness} />
                                <ColorInput label="Color" value={s.filterParams.outline.color}
                                    onChange={(v) => setFilterParam('outline', { color: v })} />
                            </div>
                        )}

                        <CheckboxRow label="Pixelate" checked={s.filters.pixelate} onChange={(v) => setFilter('pixelate', v)} />
                        {s.filters.pixelate && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Size" value={s.filterParams.pixelate.size} min={1} max={50} step={1}
                                    onChange={(v) => setFilterParam('pixelate', { size: v })}
                                    displayValue={`${s.filterParams.pixelate.size}px`} />
                            </div>
                        )}

                        <CheckboxRow label="CRT" checked={s.filters.crt} onChange={(v) => setFilter('crt', v)} />
                        {s.filters.crt && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Curvature" value={s.filterParams.crt.curvature} min={0} max={10} step={0.1}
                                    onChange={(v) => setFilterParam('crt', { curvature: v })}
                                    displayValue={s.filterParams.crt.curvature.toFixed(1)} />
                                <Slider label="Line Width" value={s.filterParams.crt.lineWidth} min={0} max={10} step={0.1}
                                    onChange={(v) => setFilterParam('crt', { lineWidth: v })}
                                    displayValue={s.filterParams.crt.lineWidth.toFixed(1)} />
                                <Slider label="Line Contrast" value={s.filterParams.crt.lineContrast} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { lineContrast: v })}
                                    displayValue={s.filterParams.crt.lineContrast.toFixed(2)} />
                                <Slider label="Vignetting" value={s.filterParams.crt.vignetting} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { vignetting: v })}
                                    displayValue={s.filterParams.crt.vignetting.toFixed(2)} />
                                <Slider label="Vignette Alpha" value={s.filterParams.crt.vignettingAlpha} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { vignettingAlpha: v })}
                                    displayValue={s.filterParams.crt.vignettingAlpha.toFixed(2)} />
                                <Slider label="Noise" value={s.filterParams.crt.noise} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { noise: v })}
                                    displayValue={s.filterParams.crt.noise.toFixed(2)} />
                            </div>
                        )}

                        <CheckboxRow label="Noise" checked={s.filters.noise} onChange={(v) => setFilter('noise', v)} />
                        {s.filters.noise && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Intensity" value={s.filterParams.noise.noise} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('noise', { noise: v })}
                                    displayValue={s.filterParams.noise.noise.toFixed(2)} />
                            </div>
                        )}

                        <CheckboxRow label="Alpha" checked={s.filters.alpha} onChange={(v) => setFilter('alpha', v)} />
                        {s.filters.alpha && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Alpha" value={s.filterParams.alpha.alpha} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('alpha', { alpha: v })}
                                    displayValue={s.filterParams.alpha.alpha.toFixed(2)} />
                            </div>
                        )}

                    </SubDrawer>

                    {/* ── Motion & Expression Test ── */}
                    <SubDrawer title="Motion & Expression Test">
                        <MotionTestSection />
                    </SubDrawer>

                </div>
            </div>

            {/* Live2D canvas portal */}
            {canvasPortal}
        </>
    );
}
