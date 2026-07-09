import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadLive2DRuntime, buildFilters, applyModelTransform } from './runtime';
import { normalizeSettings } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Live2DCanvas
//
// Renders a PIXI.Application onto a <canvas> element and manages the life-cycle
// of a single Live2D model.  Captions, lipsync, and emotion analysis are
// intentionally out of scope here.
//
// Props
//   modelUrl      – URL/path to the model .model3.json file, or null to unload
//   settings      – raw settings object (will be normalized internally)
//   showStatus    – show a loading/error overlay while the model isn't ready
//   onStatusChange(status) – callback fired on every status change
//   onModelLoad(model)     – callback fired once the model is ready (null on unload)
// ─────────────────────────────────────────────────────────────────────────────

export default function Live2DCanvas({
    modelUrl,
    settings,
    className = '',
    style = {},
    showStatus = true,
    onStatusChange,
    onModelLoad,
}) {
    const canvasRef  = useRef(null);
    const appRef     = useRef(null);
    const modelRef   = useRef(null);
    const rendererRef = useRef(null); // { PIXI, Live2DModel }

    const [status, setStatus] = useState({ state: 'idle', message: '' });

    const currentSettings = useMemo(() => normalizeSettings(settings), [settings]);

    // ── status helper ────────────────────────────────────────────────────────

    const updateStatus = useCallback((next) => {
        setStatus(next);
        onStatusChange?.(next);
    }, [onStatusChange]);

    // ── apply filters without rebuilding the whole app ───────────────────────

    const applyFilters = useCallback((nextSettings) => {
        const model = modelRef.current;
        const PIXI  = rendererRef.current?.PIXI ?? window.PIXI;
        if (!model || !PIXI) return;
        const filters = buildFilters(nextSettings, PIXI);
        model.filters = filters.length > 0 ? filters : null;
    }, []);

    // ── filters-only effect (no model reload) ────────────────────────────────

    const filtersKey = useMemo(() => JSON.stringify({
        filters:      currentSettings.filters,
        filterParams: currentSettings.filterParams,
    }), [currentSettings.filters, currentSettings.filterParams]);

    useEffect(() => {
        applyFilters(currentSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applyFilters, filtersKey]);

    // ── transform-only effect (no model reload) ──────────────────────────────

    useEffect(() => {
        applyModelTransform(modelRef.current, currentSettings);
    }, [
        currentSettings.scale,
        currentSettings.modelPositionX,
        currentSettings.modelPositionY,
        currentSettings.anchorX,
        currentSettings.anchorY,
        currentSettings.canvasWidth,
        currentSettings.canvasHeight,
        // currentSettings reference changes on every render; list individual fields
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ]);

    // ── opacity effect ───────────────────────────────────────────────────────

    useEffect(() => {
        if (canvasRef.current) {
            canvasRef.current.style.opacity = String(currentSettings.opacity);
        }
    }, [currentSettings.opacity]);

    // ── main model-load effect ───────────────────────────────────────────────

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !modelUrl) {
            updateStatus({ state: 'idle', message: '' });
            return;
        }

        let cancelled = false;

        function destroyCurrent() {
            const prevModel = modelRef.current;
            const prevApp   = appRef.current;

            if (prevModel) {
                try { prevModel.destroy(); } catch { /* noop */ }
                modelRef.current = null;
            }
            if (prevApp) {
                try { prevApp.destroy(false, { children: true }); } catch { /* noop */ }
                appRef.current = null;
            }

            onModelLoad?.(null);
            window.live2dExtModel = null;
        }

        destroyCurrent();
        updateStatus({ state: 'loading', message: 'Loading runtime…' });

        (async () => {
            try {
                // 1. Load PIXI + pixi-live2d-display scripts
                const { PIXI, Live2DModel } = await loadLive2DRuntime();
                if (cancelled) return;

                rendererRef.current = { PIXI, Live2DModel };

                // 2. Create PIXI app
                updateStatus({ state: 'loading', message: 'Loading model…' });

                const app = new PIXI.Application({
                    view:            canvas,
                    width:           currentSettings.canvasWidth,
                    height:          currentSettings.canvasHeight,
                    backgroundAlpha: 0,
                    autoStart:       true,
                    resolution:      window.devicePixelRatio || 1,
                    autoDensity:     true,
                });

                if (cancelled) {
                    try { app.destroy(false, { children: true }); } catch { /* noop */ }
                    return;
                }

                appRef.current = app;

                // 3. Load the Live2D model
                const model = await Live2DModel.from(modelUrl, { autoInteract: false });
                if (cancelled) {
                    try { model.destroy(); } catch { /* noop */ }
                    return;
                }

                modelRef.current = model;

                // 4. Interaction flags
                //    autoInteract drives the built-in eye/head cursor tracking.
                //    Hit-area events ('hit') work independently via model.interactive.
                model.autoInteract = currentSettings.followCursor;
                model.interactive  = currentSettings.enableHitTesting || currentSettings.followCursor;

                // Make stage receive pointer events for autoInteract to function
                app.stage.interactive = true;
                app.stage.hitArea     = app.renderer.screen;

                if (currentSettings.enableHitTesting) {
                    model.on('hit', (hitAreas) => {
                        console.log('[Live2D TTS] Hit areas:', hitAreas);
                        // Motion triggering from hit areas will be wired here later
                    });
                }

                // 5. Add to stage, apply transform and filters
                app.stage.addChild(model);
                applyModelTransform(model, currentSettings);
                applyFilters(currentSettings);

                // 6. Expose model globally for the settings panel test buttons
                window.live2dExtModel = model;
                onModelLoad?.(model);

                updateStatus({ state: 'ready', message: '' });
                console.log('[Live2D TTS] Model loaded:', modelUrl);

            } catch (err) {
                if (cancelled) return;
                console.error('[Live2D TTS] Failed to load model:', err);
                updateStatus({ state: 'error', message: String(err?.message ?? err) });
                onModelLoad?.(null);
            }
        })();

        return () => {
            cancelled = true;
            destroyCurrent();
        };
    // modelUrl change or canvas resize triggers a full reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelUrl, currentSettings.canvasWidth, currentSettings.canvasHeight]);

    // ── autoInteract hot-swap (no reload) ────────────────────────────────────

    useEffect(() => {
        const model = modelRef.current;
        if (!model) return;
        model.autoInteract = currentSettings.followCursor;
        model.interactive  = currentSettings.enableHitTesting || currentSettings.followCursor;
    }, [currentSettings.followCursor, currentSettings.enableHitTesting]);

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div style={{ position: 'relative', ...style }} className={className}>
            <canvas
                ref={canvasRef}
                width={currentSettings.canvasWidth}
                height={currentSettings.canvasHeight}
                style={{
                    display: 'block',
                    width:   '100%',
                    height:  '100%',
                    opacity: currentSettings.opacity,
                }}
            />
            {showStatus && status.state !== 'ready' && status.state !== 'idle' && (
                <div style={{
                    position:       'absolute',
                    top:            '8px',
                    left:           '8px',
                    right:          '8px',
                    padding:        '6px 10px',
                    background:     'rgba(0,0,0,0.6)',
                    borderRadius:   '6px',
                    fontSize:       '11px',
                    color:          status.state === 'error' ? '#ff6b6b' : 'rgba(255,255,255,0.7)',
                    pointerEvents:  'none',
                }}>
                    {status.message || status.state}
                </div>
            )}
        </div>
    );
}
