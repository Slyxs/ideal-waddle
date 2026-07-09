import { useState, useMemo, useEffect } from 'react';
import { normalizeSettings, MODEL_SOURCE, MODEL_SOURCE_LABELS, defaultSettings } from './settings';
import { readModelMotions, readModelExpressions } from './runtime';

// ─────────────────────────────────────────────────────────────────────────────
// Small reusable primitives that match ST's native UI patterns
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="inline-drawer" style={{ marginTop: '6px' }}>
            <div
                className="inline-drawer-toggle inline-drawer-header"
                onClick={() => setOpen(o => !o)}
                style={{ cursor: 'pointer' }}
            >
                <b>{title}</b>
                <div className={`inline-drawer-icon fa-solid fa-circle-chevron-down ${open ? 'up' : 'down'}`} />
            </div>
            {open && (
                <div className="inline-drawer-content">
                    {children}
                </div>
            )}
        </div>
    );
}

function Row({ children, style }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', ...style }}>
            {children}
        </div>
    );
}

function CheckRow({ label, checked, onChange, title }) {
    return (
        <Row>
            <label className="checkbox_label" title={title} style={{ flex: 1 }}>
                <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
                <span>{label}</span>
            </label>
        </Row>
    );
}

function SliderRow({ label, value, min, max, step = 0.01, onChange, format }) {
    const display = format ? format(value) : Number(value).toFixed(2).replace(/\.?0+$/, '');
    return (
        <div style={{ marginBottom: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
                <span>{label}</span>
                <span style={{ opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>{display}</span>
            </div>
            <input
                type="range"
                className="neo-range-input"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                style={{ width: '100%' }}
            />
        </div>
    );
}

function NumberInput({ label, value, min, max, step = 1, onChange }) {
    return (
        <div style={{ marginBottom: '6px' }}>
            <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px' }}>{label}</label>
            <input
                type="number"
                className="text_pole"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                style={{ width: '100%' }}
            />
        </div>
    );
}

function TextInput({ label, value, onChange, placeholder }) {
    return (
        <div style={{ marginBottom: '6px' }}>
            {label && <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px' }}>{label}</label>}
            <input
                type="text"
                className="text_pole"
                value={value}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
                style={{ width: '100%' }}
            />
        </div>
    );
}

function SelectInput({ label, value, options, onChange }) {
    return (
        <div style={{ marginBottom: '6px' }}>
            {label && <label style={{ fontSize: '12px', display: 'block', marginBottom: '2px' }}>{label}</label>}
            <select
                className="text_pole"
                value={value}
                onChange={e => onChange(e.target.value)}
                style={{ width: '100%' }}
            >
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter sub-panel
// ─────────────────────────────────────────────────────────────────────────────

function FilterPanel({ settings, onChange }) {
    const { filters, filterParams } = settings;

    function setFilter(name, enabled) {
        onChange({ filters: { ...filters, [name]: enabled } });
    }

    function setParam(filterName, paramName, value) {
        onChange({
            filterParams: {
                ...filterParams,
                [filterName]: { ...filterParams[filterName], [paramName]: value },
            },
        });
    }

    return (
        <div>
            {/* Outline */}
            <CheckRow
                label="Outline"
                checked={filters.outline}
                onChange={v => setFilter('outline', v)}
            />
            {filters.outline && (
                <div style={{ paddingLeft: '16px', marginBottom: '6px' }}>
                    <SliderRow
                        label="Thickness"
                        value={filterParams.outline.thickness}
                        min={0} max={20} step={0.5}
                        onChange={v => setParam('outline', 'thickness', v)}
                    />
                    <Row>
                        <label style={{ fontSize: '12px', flex: 1 }}>Color</label>
                        <input
                            type="color"
                            value={filterParams.outline.color}
                            onChange={e => setParam('outline', 'color', e.target.value)}
                            style={{ width: '36px', height: '28px', cursor: 'pointer', border: 'none', background: 'none' }}
                        />
                        <input
                            type="text"
                            className="text_pole"
                            value={filterParams.outline.color}
                            onChange={e => setParam('outline', 'color', e.target.value)}
                            style={{ width: '80px', fontFamily: 'monospace' }}
                        />
                    </Row>
                </div>
            )}

            {/* Pixelate */}
            <CheckRow
                label="Pixelate"
                checked={filters.pixelate}
                onChange={v => setFilter('pixelate', v)}
            />
            {filters.pixelate && (
                <div style={{ paddingLeft: '16px', marginBottom: '6px' }}>
                    <SliderRow
                        label="Size"
                        value={filterParams.pixelate.size}
                        min={1} max={50} step={1}
                        format={v => String(Math.round(v)) + 'px'}
                        onChange={v => setParam('pixelate', 'size', v)}
                    />
                </div>
            )}

            {/* CRT */}
            <CheckRow
                label="CRT"
                checked={filters.crt}
                onChange={v => setFilter('crt', v)}
            />
            {filters.crt && (
                <div style={{ paddingLeft: '16px', marginBottom: '6px' }}>
                    <SliderRow label="Curvature"       value={filterParams.crt.curvature}       min={0} max={20}  step={0.5}  onChange={v => setParam('crt', 'curvature',       v)} />
                    <SliderRow label="Line width"      value={filterParams.crt.lineWidth}        min={0} max={20}  step={0.5}  onChange={v => setParam('crt', 'lineWidth',        v)} />
                    <SliderRow label="Line contrast"   value={filterParams.crt.lineContrast}     min={0} max={1}   step={0.01} onChange={v => setParam('crt', 'lineContrast',     v)} />
                    <SliderRow label="Vignetting"      value={filterParams.crt.vignetting}       min={0} max={1}   step={0.01} onChange={v => setParam('crt', 'vignetting',       v)} />
                    <SliderRow label="Vignette alpha"  value={filterParams.crt.vignettingAlpha}  min={0} max={1}   step={0.01} onChange={v => setParam('crt', 'vignettingAlpha',  v)} />
                    <SliderRow label="Noise"           value={filterParams.crt.noise}            min={0} max={1}   step={0.01} onChange={v => setParam('crt', 'noise',            v)} />
                </div>
            )}

            {/* Noise */}
            <CheckRow
                label="Noise"
                checked={filters.noise}
                onChange={v => setFilter('noise', v)}
            />
            {filters.noise && (
                <div style={{ paddingLeft: '16px', marginBottom: '6px' }}>
                    <SliderRow
                        label="Amount"
                        value={filterParams.noise.noise}
                        min={0} max={1} step={0.01}
                        onChange={v => setParam('noise', 'noise', v)}
                    />
                </div>
            )}

            {/* Alpha */}
            <CheckRow
                label="Alpha (transparency)"
                checked={filters.alpha}
                onChange={v => setFilter('alpha', v)}
            />
            {filters.alpha && (
                <div style={{ paddingLeft: '16px', marginBottom: '6px' }}>
                    <SliderRow
                        label="Alpha"
                        value={filterParams.alpha.alpha}
                        min={0} max={1} step={0.01}
                        onChange={v => setParam('alpha', 'alpha', v)}
                    />
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Motion & Expression test panel
// ─────────────────────────────────────────────────────────────────────────────

function MotionTestPanel({ model }) {
    const motions     = useMemo(() => model ? readModelMotions(model)     : {}, [model]);
    const expressions = useMemo(() => model ? readModelExpressions(model) : [], [model]);
    const motionGroups = Object.entries(motions);

    if (!model) {
        return (
            <p style={{ fontSize: '12px', opacity: 0.6, margin: '4px 0' }}>
                No model loaded yet.
            </p>
        );
    }

    function playMotion(group, index) {
        try {
            model.motion(group, index);
        } catch (err) {
            console.warn('[Live2D TTS] Motion playback error:', err);
        }
    }

    function playExpression(index) {
        try {
            model.expression(index);
        } catch (err) {
            console.warn('[Live2D TTS] Expression playback error:', err);
        }
    }

    return (
        <div>
            {motionGroups.length === 0 && expressions.length === 0 && (
                <p style={{ fontSize: '12px', opacity: 0.6, margin: '4px 0' }}>
                    This model has no motions or expressions defined.
                </p>
            )}

            {motionGroups.length > 0 && (
                <div style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>Motions</div>
                    {motionGroups.map(([group, labels]) => (
                        <div key={group} style={{ marginBottom: '6px' }}>
                            <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '3px' }}>{group}</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {labels.map((label, index) => (
                                    <button
                                        key={index}
                                        type="button"
                                        className="menu_button"
                                        title={`${group} › ${label}`}
                                        onClick={() => playMotion(group, index)}
                                        style={{ fontSize: '11px', padding: '3px 8px' }}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {expressions.length > 0 && (
                <div>
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>Expressions</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {expressions.map((label, index) => (
                            <button
                                key={index}
                                type="button"
                                className="menu_button"
                                title={`Expression ${index}: ${label}`}
                                onClick={() => playExpression(index)}
                                style={{ fontSize: '11px', padding: '3px 8px' }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsPanel — main exported component
// ─────────────────────────────────────────────────────────────────────────────

export default function SettingsPanel({ settings, onChange, model }) {
    const s = useMemo(() => normalizeSettings(settings), [settings]);

    function set(patch) {
        onChange(patch);
    }

    const modelSourceOptions = Object.values(MODEL_SOURCE).map(v => ({
        value: v,
        label: MODEL_SOURCE_LABELS[v],
    }));

    return (
        <div className="extension_container">
            <div className="inline-drawer">
                <div className="inline-drawer-toggle inline-drawer-header">
                    <b>Live2D TTS</b>
                    <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down" />
                </div>

                <div className="inline-drawer-content">

                    {/* ── Master enable ─────────────────────────────────── */}
                    <CheckRow
                        label="Enable Live2D"
                        title="Enables the Live2D overlay and automatically intercepts TTS audio"
                        checked={s.enabled}
                        onChange={v => set({ enabled: v })}
                    />

                    {/* ── Model source ──────────────────────────────────── */}
                    <Section title="Model Source">
                        <SelectInput
                            label="Source"
                            value={s.modelSource}
                            options={modelSourceOptions}
                            onChange={v => set({ modelSource: v })}
                        />

                        {s.modelSource === MODEL_SOURCE.URL && (
                            <TextInput
                                label="Model URL (.model3.json)"
                                value={s.customUrl}
                                placeholder="https://example.com/path/to/model.model3.json"
                                onChange={v => set({ customUrl: v })}
                            />
                        )}

                        {s.modelSource === MODEL_SOURCE.LOCAL && (
                            <TextInput
                                label="Local path (relative to SillyTavern root)"
                                value={s.localPath}
                                placeholder="/assets/live2d/mymodel/model.model3.json"
                                onChange={v => set({ localPath: v })}
                            />
                        )}
                    </Section>

                    {/* ── Interaction ───────────────────────────────────── */}
                    <Section title="Interaction">
                        <CheckRow
                            label="Follow cursor"
                            title="Model eyes and head track the mouse cursor"
                            checked={s.followCursor}
                            onChange={v => set({ followCursor: v })}
                        />
                        <CheckRow
                            label="Enable dragging"
                            title="Show a drag handle to reposition the overlay"
                            checked={s.draggable}
                            onChange={v => set({ draggable: v })}
                        />
                        <CheckRow
                            label="Enable hit testing"
                            title="Clicking model hit areas triggers reactions"
                            checked={s.enableHitTesting}
                            onChange={v => set({ enableHitTesting: v })}
                        />
                    </Section>

                    {/* ── Rendering ─────────────────────────────────────── */}
                    <Section title="Rendering">
                        <Row>
                            <NumberInput label="Canvas width"  value={s.canvasWidth}  min={100} max={2000} onChange={v => set({ canvasWidth: v })}  />
                            <NumberInput label="Canvas height" value={s.canvasHeight} min={100} max={2000} onChange={v => set({ canvasHeight: v })} />
                        </Row>

                        <SliderRow
                            label="Scale"
                            value={s.scale}
                            min={0.05} max={5} step={0.01}
                            onChange={v => set({ scale: v })}
                        />
                        <SliderRow
                            label="Opacity"
                            value={s.opacity}
                            min={0} max={1} step={0.01}
                            onChange={v => set({ opacity: v })}
                        />

                        <div style={{ fontSize: '12px', fontWeight: 600, margin: '8px 0 4px' }}>
                            Overlay position (% of viewport)
                        </div>
                        <SliderRow
                            label="Position X"
                            value={s.positionX}
                            min={0} max={100} step={0.5}
                            format={v => `${Math.round(v)}%`}
                            onChange={v => set({ positionX: v })}
                        />
                        <SliderRow
                            label="Position Y"
                            value={s.positionY}
                            min={0} max={100} step={0.5}
                            format={v => `${Math.round(v)}%`}
                            onChange={v => set({ positionY: v })}
                        />

                        <div style={{ fontSize: '12px', fontWeight: 600, margin: '8px 0 4px' }}>
                            Model position within canvas (%)
                        </div>
                        <SliderRow
                            label="Model X"
                            value={s.modelPositionX}
                            min={0} max={100} step={0.5}
                            format={v => `${Math.round(v)}%`}
                            onChange={v => set({ modelPositionX: v })}
                        />
                        <SliderRow
                            label="Model Y"
                            value={s.modelPositionY}
                            min={0} max={100} step={0.5}
                            format={v => `${Math.round(v)}%`}
                            onChange={v => set({ modelPositionY: v })}
                        />

                        <div style={{ fontSize: '12px', fontWeight: 600, margin: '8px 0 4px' }}>
                            Anchor point (0 = left/top, 0.5 = center, 1 = right/bottom)
                        </div>
                        <SliderRow label="Anchor X" value={s.anchorX} min={0} max={1} step={0.01} onChange={v => set({ anchorX: v })} />
                        <SliderRow label="Anchor Y" value={s.anchorY} min={0} max={1} step={0.01} onChange={v => set({ anchorY: v })} />

                        <NumberInput label="Z-index" value={s.zIndex} min={0} max={9999} onChange={v => set({ zIndex: v })} />
                    </Section>

                    {/* ── Filters ───────────────────────────────────────── */}
                    <Section title="Filters">
                        <FilterPanel settings={s} onChange={patch => set(patch)} />
                    </Section>

                    {/* ── Motion / Expression test ──────────────────────── */}
                    <Section title="Motion & Expression Test">
                        <MotionTestPanel model={model} />
                    </Section>

                </div>
            </div>
        </div>
    );
}
