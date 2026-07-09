import { useState } from 'react';

function App({ getEnabled, setEnabled }) {
    const [enabled, setEnabledState] = useState(getEnabled());

    function handleToggle() {
        const next = !enabled;
        setEnabledState(next);
        setEnabled(next);
        console.log('[Live2D TTS] Interception', next ? 'enabled' : 'disabled');
    }

    return (
        <div className="extension_container">
            <div className="inline-drawer">
                <div className="inline-drawer-toggle inline-drawer-header">
                    <b>Live2D TTS</b>
                    <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div className="inline-drawer-content">
                    <label
                        className="checkbox_label"
                        title="Intercept TTS audio and prevent SillyTavern from playing it back"
                    >
                        <input
                            type="checkbox"
                            checked={enabled}
                            onChange={handleToggle}
                        />
                        <span>Intercept TTS Audio</span>
                    </label>
                    {enabled && (
                        <p style={{ margin: '4px 0 0', fontSize: '0.85em', opacity: 0.7 }}>
                            TTS audio is intercepted — check the console for blob URLs.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default App;
