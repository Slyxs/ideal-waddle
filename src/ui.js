import { useCallback, useEffect, useRef, useState } from 'react';
import { ANALYSIS_SOURCES, BUILTIN_CLASSIFIER_EMOTION_LABELS, fetchOpenAiModels } from './dynamicAnalysis';

export const LIVE2D_PLUS_SETTINGS_STYLES = `
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

.live2d-plus-settings .full-width-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    box-sizing: border-box;
    margin: 8px 0;
    text-align: center;
}

.live2d-plus-settings .slider-with-input {
    margin-bottom: 8px;
}

.live2d-plus-settings .slider-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 2px;
}

.live2d-plus-settings .slider-value-input {
    width: 82px;
    min-width: 82px;
    height: 24px;
    padding: 2px 6px;
    text-align: right;
}

.live2d-plus-settings .hint {
    margin: 4px 0 8px;
    font-size: 0.82em;
    opacity: 0.62;
}

.live2d-plus-settings .section-details {
    margin-top: 8px;
}

.live2d-plus-settings .section-details > summary {
    cursor: pointer;
    padding: 4px 0;
    font-weight: 700;
    user-select: none;
}

.live2d-plus-settings .section-details > summary b {
    font-size: 0.9em;
}

.live2d-plus-settings .section-details-content {
    padding-top: 6px;
    padding-bottom: 2px;
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
    grid-template-columns: minmax(96px, 0.8fr) 1fr;
    align-items: start;
}

.live2d-plus-settings .tap-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.live2d-plus-settings .tap-selects {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr);
    gap: 6px;
}

.live2d-plus-settings .tap-fields textarea.text_pole {
    min-height: 54px;
    resize: vertical;
}

.live2d-plus-settings .tap-meta {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    margin: 4px 0 8px;
}

.live2d-plus-settings .tap-meta small {
    min-width: 0;
    opacity: 0.62;
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

const EMPTY_MODEL_INFO = Object.freeze({ name: '', motions: {}, expressions: [], hitAreas: [] });

function modelInfoSignature(info = EMPTY_MODEL_INFO) {
    const motions = Object.entries(info?.motions || {})
        .map(([groupName, groupMotions]) => [groupName, Array.isArray(groupMotions) ? groupMotions.length : 0])
        .sort(([left], [right]) => left.localeCompare(right));
    const expressions = Array.isArray(info?.expressions) ? info.expressions.map((expression, index) => getExpressionLabel(expression, index)) : [];
    const hitAreas = Array.isArray(info?.hitAreas)
        ? info.hitAreas.map((hitArea) => `${hitArea.id || ''}:${hitArea.name || ''}:${hitArea.index ?? ''}`)
        : [];

    return JSON.stringify({ name: info?.name || '', motions, expressions, hitAreas });
}

function setModelInfoIfChanged(setModelInfo, nextInfo) {
    const next = nextInfo || EMPTY_MODEL_INFO;
    setModelInfo((current) => (
        modelInfoSignature(current) === modelInfoSignature(next) ? current : next
    ));
    return next;
}

function readLiveModelInfo(readRuntimeModelInfo) {
    if (typeof window === 'undefined' || typeof readRuntimeModelInfo !== 'function') {
        return EMPTY_MODEL_INFO;
    }

    return window.live2dPlusModelInfo || readRuntimeModelInfo(window.live2dPlusModel) || EMPTY_MODEL_INFO;
}

export function CheckboxRow({ label, checked, onChange }) {
    return (
        <label className="checkbox_label" style={{ marginBottom: '4px' }}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>{label}</span>
        </label>
    );
}

export function Slider({ label, value, min, max, step, onChange, displayValue, showInput = false, inputMin, inputMax, inputStep }) {
    const display = displayValue !== undefined ? displayValue : value;
    const numericValue = Number(value);
    const rangeValue = Number.isFinite(numericValue)
        ? Math.min(Math.max(numericValue, min), max)
        : min;
    const handleInputChange = (event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
    };

    return (
        <div className="slider-with-input">
            <div className="slider-header">
                <small>{label}</small>
                {showInput ? (
                    <input
                        type="number"
                        className="text_pole slider-value-input"
                        min={inputMin ?? min}
                        max={inputMax}
                        step={inputStep ?? step}
                        value={value}
                        onChange={handleInputChange}
                    />
                ) : (
                    <small style={{ opacity: 0.7 }}>{display}</small>
                )}
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={rangeValue}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{ width: '100%' }}
            />
        </div>
    );
}

export function formatNumber(value, digits = 2) {
    return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function ColorInput({ label, value, onChange }) {
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

export function SubDrawer({ title, children, defaultOpen = false }) {
    return (
        <details className="section-details" open={defaultOpen || undefined}>
            <summary>
                <b>{title}</b>
            </summary>
            <div className="section-details-content">
                {children}
            </div>
        </details>
    );
}

export function getMotionLabel(motion, index) {
    const raw = typeof motion === 'string'
        ? motion
        : motion?.File || motion?.file || motion?.name || motion?.Name || `Motion ${index + 1}`;
    return String(raw).replace(/\.(mtn|json)$/i, '');
}

export function getExpressionLabel(expr, index) {
    if (typeof expr === 'string') return expr.replace(/\.(exp3?|json)$/i, '');
    return expr?.name || expr?.Name || expr?.File || expr?.file || `Expression ${index}`;
}

export function MotionTestSection({
    defaultStateResetDelayMs = 1800,
    resetDynamicState,
    stopModelMotionsOnly,
    readMotionDurationMs,
    getMotionManager,
}) {
    const [modelInfo, setModelInfo] = useState({ name: '', motions: {}, expressions: [], message: '' });
    const resetTimerRef = useRef(0);

    const clearTestReset = useCallback(() => {
        if (resetTimerRef.current && typeof window !== 'undefined') {
            window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = 0;
    }, []);

    const scheduleTestReset = useCallback((model, delayMs = defaultStateResetDelayMs) => {
        clearTestReset();
        if (!model) return;
        if (typeof window === 'undefined') {
            resetDynamicState?.(model);
            return;
        }

        const safeDelay = Math.min(Math.max(Number(delayMs) || 0, 0), 60000);
        resetTimerRef.current = window.setTimeout(() => {
            resetTimerRef.current = 0;
            resetDynamicState?.(model);
        }, safeDelay);
    }, [clearTestReset, defaultStateResetDelayMs, resetDynamicState]);

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

        const motionManager = getMotionManager?.(model);
        let resetHandled = false;
        let detachMotionFinish = () => {};

        const resetOnce = () => {
            if (resetHandled) return;
            resetHandled = true;
            detachMotionFinish();
            clearTestReset();
            resetDynamicState?.(model);
        };

        try {
            clearTestReset();
            stopModelMotionsOnly?.(model);

            if (motionManager?.on) {
                const handleMotionFinish = () => resetOnce();
                motionManager.on('motionFinish', handleMotionFinish);
                detachMotionFinish = () => {
                    try { motionManager.off?.('motionFinish', handleMotionFinish); } catch { /* noop */ }
                    try { motionManager.removeListener?.('motionFinish', handleMotionFinish); } catch { /* noop */ }
                };
            }

            let fallbackDelay = defaultStateResetDelayMs;
            try {
                const motion = await motionManager?.loadMotion?.(group, index);
                fallbackDelay = readMotionDurationMs?.(motion) ?? defaultStateResetDelayMs;
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

function readMappingByLabel(mappings, label) {
    const key = typeof label === 'string' ? label.trim() : '';
    if (!key || !mappings || typeof mappings !== 'object') return {};
    if (mappings[key]) return mappings[key];
    const lowerKey = key.toLowerCase();
    const matchedKey = Object.keys(mappings).find((mappingKey) => mappingKey.toLowerCase() === lowerKey);
    return matchedKey ? mappings[matchedKey] : {};
}

export function DynamicSettingsSection({ settings, onChange, readRuntimeModelInfo, modelInfoEventName }) {
    const [modelInfo, setModelInfo] = useState(() => readLiveModelInfo(readRuntimeModelInfo));
    const [availableModels, setAvailableModels] = useState([]);
    const [modelFetchState, setModelFetchState] = useState({ loading: false, message: '' });

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const updateModelInfo = (event) => setModelInfoIfChanged(
            setModelInfo,
            event.detail || readLiveModelInfo(readRuntimeModelInfo),
        );
        window.addEventListener(modelInfoEventName, updateModelInfo);
        setModelInfoIfChanged(setModelInfo, readLiveModelInfo(readRuntimeModelInfo));
        return () => window.removeEventListener(modelInfoEventName, updateModelInfo);
    }, [modelInfoEventName, readRuntimeModelInfo]);

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
    const isBuiltInClassifier = settings.analysisSource === ANALYSIS_SOURCES.SILLYTAVERN_CLASSIFIER;
    const emotionLabels = isBuiltInClassifier ? BUILTIN_CLASSIFIER_EMOTION_LABELS : settings.emotionLabels;
    const priorityRows = settings.priorityList
        .map((item, originalIndex) => ({ item, originalIndex }))
        .filter(({ item }) => !isBuiltInClassifier || item.type !== 'action');

    const update = (patch) => onChange({
        ...settings,
        routeTtsToLive2D: true,
        blockOriginalTtsPlayback: true,
        ...patch,
    });
    const updateAnalysisSource = (analysisSource) => {
        const patch = { analysisSource };
        if (analysisSource === ANALYSIS_SOURCES.SILLYTAVERN_CLASSIFIER) {
            patch.disableSettings = {
                ...settings.disableSettings,
                actionMotions: true,
                actionExpressions: true,
            };
        }
        update(patch);
    };
    const updateDisable = (key, value) => {
        if (isBuiltInClassifier && key.startsWith('action')) return;
        update({ disableSettings: { ...settings.disableSettings, [key]: value } });
    };
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
        const visibleIndex = priorityRows.findIndex((row) => row.originalIndex === index);
        const targetRow = priorityRows[visibleIndex + direction];
        if (!targetRow) return;
        const next = [...settings.priorityList];
        const target = targetRow.originalIndex;
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
        if (isBuiltInClassifier) return;
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
                label="Dynamic cue mode"
                checked={settings.dynamicMode}
                onChange={(value) => update({ dynamicMode: value })}
            />
            <CheckboxRow
                label="Reset expression after playback"
                checked={settings.resetExpressionAfterPlayback}
                onChange={(value) => update({ resetExpressionAfterPlayback: value })}
            />

            <label className="field">
                <span>Analysis source</span>
                <select
                    className="text_pole"
                    value={settings.analysisSource}
                    onChange={(event) => updateAnalysisSource(event.target.value)}
                >
                    <option value={ANALYSIS_SOURCES.OPENAI}>External LLM (OpenAI-compatible)</option>
                    <option value={ANALYSIS_SOURCES.SILLYTAVERN_CLASSIFIER}>SillyTavern built-in classifier</option>
                </select>
            </label>

            {isBuiltInClassifier && (
                <div className="hint">
                    Built-in classifier mode returns one emotion for the whole TTS text, so Live2D+ plays it as a single segment. Segment splitting and action mappings are only available with the external LLM source.
                </div>
            )}

            {!isBuiltInClassifier && (
                <>
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
                    <button className="menu_button full-width-action" type="button" onClick={fetchModels} disabled={modelFetchState.loading}>
                        {modelFetchState.loading ? 'Fetching...' : 'Fetch Models'}
                    </button>
                    {modelFetchState.message && <div className="hint">{modelFetchState.message}</div>}
                    <label className="field">
                        <span>Analysis model</span>
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
                    </label>
                </>
            )}

            <div className="section-caption">Disable cue sources</div>
            <CheckboxRow label="Emotion motions" checked={!settings.disableSettings.emotionMotions} onChange={(value) => updateDisable('emotionMotions', !value)} />
            <CheckboxRow label="Emotion expressions" checked={!settings.disableSettings.emotionExpressions} onChange={(value) => updateDisable('emotionExpressions', !value)} />
            {!isBuiltInClassifier && (
                <>
                    <CheckboxRow label="Action motions" checked={!settings.disableSettings.actionMotions} onChange={(value) => updateDisable('actionMotions', !value)} />
                    <CheckboxRow label="Action expressions" checked={!settings.disableSettings.actionExpressions} onChange={(value) => updateDisable('actionExpressions', !value)} />
                </>
            )}

            <div className="section-caption">Priority</div>
            <div className="mapping-list compact">
                {priorityRows.map(({ item, originalIndex }, visibleIndex) => (
                    <div className="mapping-row priority-row" key={`${item.type}-${item.target}`}>
                        <span>{item.label}</span>
                        <div className="row-actions">
                            <button className="menu_button" type="button" onClick={() => movePriority(originalIndex, -1)} disabled={visibleIndex === 0}>Up</button>
                            <button className="menu_button" type="button" onClick={() => movePriority(originalIndex, 1)} disabled={visibleIndex === priorityRows.length - 1}>Down</button>
                        </div>
                    </div>
                ))}
            </div>

            <div className="section-caption">Emotion mappings</div>
            <div className="mapping-list">
                {emotionLabels.map((emotion) => {
                    const mapping = readMappingByLabel(settings.emotionMappings, emotion);
                    return (
                        <div className="mapping-row" key={emotion}>
                            <strong>{emotion}</strong>
                            <MappingSelect label="Motion" value={mapping.motion} options={motionOptions} onChange={(value) => updateEmotionMapping(emotion, { motion: value })} />
                            <MappingSelect label="Expression" value={mapping.expression} options={expressionOptions} onChange={(value) => updateEmotionMapping(emotion, { expression: value })} />
                        </div>
                    );
                })}
            </div>

            {!isBuiltInClassifier && (
                <>
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
                    <button className="menu_button full-width-action" type="button" onClick={addActionMapping}>Add Action</button>
                </>
            )}
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

export function TapInteractionsSection({ settings, onChange, readRuntimeModelInfo, modelInfoEventName }) {
    const [modelInfo, setModelInfo] = useState(() => readLiveModelInfo(readRuntimeModelInfo));

    const refreshModelInfo = useCallback(() => {
        if (typeof window === 'undefined' || typeof readRuntimeModelInfo !== 'function') {
            setModelInfoIfChanged(setModelInfo, EMPTY_MODEL_INFO);
            return EMPTY_MODEL_INFO;
        }

        const detail = readRuntimeModelInfo(window.live2dPlusModel);
        window.live2dPlusModelInfo = detail;
        setModelInfoIfChanged(setModelInfo, detail);
        return detail;
    }, [readRuntimeModelInfo]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const updateModelInfo = (event) => setModelInfoIfChanged(
            setModelInfo,
            event.detail || readLiveModelInfo(readRuntimeModelInfo),
        );
        window.addEventListener(modelInfoEventName, updateModelInfo);
        refreshModelInfo();
        return () => window.removeEventListener(modelInfoEventName, updateModelInfo);
    }, [modelInfoEventName, readRuntimeModelInfo, refreshModelInfo]);

    useEffect(() => {
        refreshModelInfo();
    }, [refreshModelInfo, settings.modelSource, settings.customModelUrl, settings.localModelPath, settings.reloadKey]);

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
            <div className="tap-fields">
                <div className="tap-selects">
                    <MappingSelect label="Motion" value={mapping.motion} options={motionOptions} onChange={(value) => updateMapping({ motion: value })} />
                    <MappingSelect label="Expression" value={mapping.expression} options={expressionOptions} onChange={(value) => updateMapping({ expression: value })} />
                </div>
                <TapMessageInput value={mapping.message} onChange={(value) => updateMapping({ message: value })} />
            </div>
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

            <div className="tap-meta">
                <small>
                    {modelInfo?.name ? `${modelInfo.name}: ${hitAreas.length} hit area${hitAreas.length === 1 ? '' : 's'}` : 'No active model loaded.'}
                </small>
                <button className="menu_button full-width-action" type="button" onClick={refreshModelInfo}>
                    Refresh Hit Areas
                </button>
            </div>

            <div className="section-caption">Default tap</div>
            <div className="mapping-list compact">
                {renderMappingRow(
                    { id: 'default', name: 'Default / model body' },
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