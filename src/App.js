import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeSettings, resolveModelUrl, MODEL_SOURCES } from './settings';
import { loadLive2DRuntime, buildFilters, applyModelTransform, applyModelInteraction } from './live2d';

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

    function playMotion(group, index) {
        try { window.live2dPlusModel?.motion?.(group, index); }
        catch (err) { console.error('[Live2D+] Motion error:', err); }
    }

    function playExpression(index) {
        try { window.live2dPlusModel?.expression?.(index); }
        catch (err) { console.error('[Live2D+] Expression error:', err); }
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

// ---------------------------------------------------------------------------
// Live2D Canvas — rendered as a portal to document.body
// ---------------------------------------------------------------------------

function Live2DCanvas({ settings, onPositionCommit }) {
    const containerRef = useRef(null);
    const appRef = useRef(null);
    const modelRef = useRef(null);
    const rendererRef = useRef(null);
    const dragStateRef = useRef(null);
    const [status, setStatus] = useState({ state: 'loading', message: 'Initializing...' });
    const [pos, setPos] = useState({ x: settings.positionX, y: settings.positionY });

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
                    settings.enableHitTesting || settings.followCursor ? 'auto' : 'none';
                container.appendChild(view);

                const model = Live2DModel.fromSync(modelUrl, {
                    autoFocus: !!settings.followCursor,
                    autoHitTest: !!settings.enableHitTesting,
                });

                if (cancelled) { model.destroy?.(); return; }
                modelRef.current = model;

                model.once('load', () => {
                    if (cancelled) { model.destroy?.(); return; }
                    app.stage.addChild(model);
                    model.alpha = settings.opacity;
                    applyModelTransform(model, settings);
                    applyModelInteraction(model, settings);
                    applyFilters(settings);
                    window.live2dPlusModel = model;
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
                settings.enableHitTesting || settings.followCursor ? 'auto' : 'none';
        }
    }, [settings.followCursor, settings.enableHitTesting]);

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
        <div style={wrapperStyle} data-live2dplus-root="true">
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
            {/* ── Main settings drawer ── */}
            <div className="inline-drawer">
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
                                placeholder="/scripts/extensions/third-party/Extension-Live2D-Plus/models/…tar.gz"
                                value={s.voskModelUrl}
                                onChange={(e) => set({ voskModelUrl: e.target.value })}
                                style={{ width: '100%', marginBottom: '4px' }}
                            />
                            <small style={{ opacity: 0.5 }}>
                                Leave empty to use the bundled default model. Drop your own
                                <code> .tar.gz </code> models in the extension's <code>models/</code> folder.
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
