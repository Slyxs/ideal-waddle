import { useState } from 'react';
import { normalizeSettings } from './live2d/settings';
import SettingsPanel from './live2d/SettingsPanel';
import Live2DRuntime from './live2d/Live2DRuntime';

// ─────────────────────────────────────────────────────────────────────────────
// App
//
// Root component.  Owns the settings state and the reference to the loaded
// Live2D model.  Renders:
//   • SettingsPanel  – in the ST extensions_settings sidebar
//   • Live2DRuntime  – portalled to document.body (only when enabled)
// ─────────────────────────────────────────────────────────────────────────────

export default function App({ loadSettings, saveSettings }) {
    const [settings, setSettings] = useState(() => normalizeSettings(loadSettings()));
    const [model,    setModel]    = useState(null);

    function handleChange(patch) {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            return next;
        });
    }

    return (
        <>
            <SettingsPanel
                settings={settings}
                onChange={handleChange}
                model={model}
            />
            <Live2DRuntime
                settings={settings}
                onChange={handleChange}
                onModelLoad={setModel}
            />
        </>
    );
}
