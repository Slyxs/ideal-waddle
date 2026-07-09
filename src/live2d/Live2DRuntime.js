import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeSettings, resolveModelUrl } from './settings';
import Live2DCanvas from './Live2DCanvas';

// ─────────────────────────────────────────────────────────────────────────────
// Live2DRuntime
//
// Portal-based overlay that positions Live2DCanvas on top of the page.
// Handles drag-to-reposition and commits the new position back via onChange.
//
// Props
//   settings          – raw settings object
//   onChange(patch)   – called with { positionX, positionY } after a drag
//   onModelLoad(model)– forwarded to Live2DCanvas
// ─────────────────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export default function Live2DRuntime({ settings, onChange, onModelLoad }) {
    const currentSettings = useMemo(() => normalizeSettings(settings), [settings]);
    const modelUrl = useMemo(() => resolveModelUrl(currentSettings), [currentSettings]);

    // Local drag position — initialised from settings, updated during drag
    const [position, setPosition] = useState({
        x: currentSettings.positionX,
        y: currentSettings.positionY,
    });
    const dragStateRef = useRef(null);

    // Sync position when settings change externally (and not dragging)
    useEffect(() => {
        if (dragStateRef.current) return;
        setPosition({ x: currentSettings.positionX, y: currentSettings.positionY });
    }, [currentSettings.positionX, currentSettings.positionY]);

    const commitPosition = useCallback((nextPosition) => {
        onChange?.({
            positionX: Number(nextPosition.x.toFixed(2)),
            positionY: Number(nextPosition.y.toFixed(2)),
        });
    }, [onChange]);

    // ── pointer drag handlers ────────────────────────────────────────────────

    const handleDragStart = useCallback((event) => {
        if (!currentSettings.draggable) return;
        event.preventDefault();
        event.stopPropagation();

        dragStateRef.current = {
            pointerId:    event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX:       position.x,
            startY:       position.y,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }, [currentSettings.draggable, position.x, position.y]);

    const handleDragMove = useCallback((event) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const deltaX = ((event.clientX - drag.startClientX) / Math.max(window.innerWidth,  1)) * 100;
        const deltaY = ((event.clientY - drag.startClientY) / Math.max(window.innerHeight, 1)) * 100;

        setPosition({
            x: clamp(drag.startX + deltaX, 0, 100),
            y: clamp(drag.startY + deltaY, 0, 100),
        });
    }, []);

    const handleDragEnd = useCallback((event) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragStateRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);

        setPosition((latestPosition) => {
            commitPosition(latestPosition);
            return latestPosition;
        });
    }, [commitPosition]);

    // ── render ───────────────────────────────────────────────────────────────

    if (!currentSettings.enabled || typeof document === 'undefined') return null;

    const canvasPointerEvents =
        (currentSettings.enableHitTesting || currentSettings.followCursor) ? 'auto' : 'none';

    const wrapperStyle = {
        position:  'fixed',
        left:      `${position.x}%`,
        top:       `${position.y}%`,
        width:     `${currentSettings.canvasWidth}px`,
        height:    `${currentSettings.canvasHeight}px`,
        transform: 'translate(-50%, -50%)',
        zIndex:    currentSettings.zIndex,
        userSelect: 'none',
        pointerEvents: 'none',
    };

    const dragButtonStyle = {
        position:       'absolute',
        right:          '10px',
        top:            '10px',
        width:          '32px',
        height:         '32px',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        borderRadius:   '50%',
        border:         '1px solid rgba(255,255,255,0.2)',
        background:     'rgba(0,0,0,0.5)',
        color:          'rgba(255,255,255,0.8)',
        cursor:         'grab',
        pointerEvents:  'auto',
        backdropFilter: 'blur(4px)',
        fontSize:       '14px',
        lineHeight:     1,
        zIndex:         1,
    };

    return createPortal(
        <div style={wrapperStyle} data-live2d-tts-runtime="true">
            <Live2DCanvas
                modelUrl={modelUrl}
                settings={currentSettings}
                showStatus
                style={{ width: '100%', height: '100%', pointerEvents: canvasPointerEvents }}
                onModelLoad={onModelLoad}
            />

            {currentSettings.draggable && (
                <button
                    type="button"
                    aria-label="Move Live2D model"
                    title="Drag to reposition"
                    style={dragButtonStyle}
                    onPointerDown={handleDragStart}
                    onPointerMove={handleDragMove}
                    onPointerUp={handleDragEnd}
                    onPointerCancel={handleDragEnd}
                >
                    ✥
                </button>
            )}
        </div>,
        document.body,
    );
}
