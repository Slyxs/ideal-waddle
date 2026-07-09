/* global SillyTavern */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { normalizeSettings, SETTINGS_KEY } from './settings';

// ---------------------------------------------------------------------------
// Initialize and mount the extension
// ---------------------------------------------------------------------------

(function init() {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (!ctx) {
        console.error('[Live2D+] SillyTavern context not available.');
        return;
    }

    const { extensionSettings, saveSettingsDebounced } = ctx;

    // Initialize settings namespace
    if (!extensionSettings[SETTINGS_KEY]) {
        extensionSettings[SETTINGS_KEY] = {};
    }
    // Ensure all fields are present and valid
    extensionSettings[SETTINGS_KEY] = normalizeSettings(extensionSettings[SETTINGS_KEY]);

    // Mount React into extensions_settings panel
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[Live2D+] #extensions_settings not found.');
        return;
    }

    const root = document.createElement('div');
    container.appendChild(root);

    function Root() {
        const [settings, setSettings] = useState(() =>
            normalizeSettings(extensionSettings[SETTINGS_KEY])
        );

        function handleChange(patch) {
            setSettings((prev) => {
                const next = normalizeSettings({ ...prev, ...patch });
                // Persist to ST's extension settings
                Object.assign(extensionSettings[SETTINGS_KEY], next);
                saveSettingsDebounced();
                return next;
            });
        }

        return <App settings={settings} onChange={handleChange} />;
    }

    const reactRoot = ReactDOM.createRoot(root);
    reactRoot.render(<Root />);
})();
