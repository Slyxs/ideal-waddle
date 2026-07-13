/* global SillyTavern */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { normalizeSettings, SETTINGS_KEY } from './settings';
import {
    setupSttPipeline,
    loadSttModel,
    getSttModelState,
    subscribeSttModelState,
    DEFAULT_VOSK_MODEL_URL,
} from './stt';

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

    // STT pipeline: intercepts TTS audio and logs Vosk word timestamps.
    // It reads live settings straight from ST's stored settings so it always
    // sees the latest toggle/model values.
    const getModelUrl = () =>
        extensionSettings[SETTINGS_KEY]?.voskModelUrl?.trim() || DEFAULT_VOSK_MODEL_URL;
    const getSettings = () => normalizeSettings(extensionSettings[SETTINGS_KEY]);

    setupSttPipeline({
        isEnabled: () => extensionSettings[SETTINGS_KEY]?.sttEnabled === true,
        getModelUrl,
        getSettings,
    });

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
        const [sttModel, setSttModel] = useState(() => getSttModelState());

        // Keep the Vosk model load state in sync with the pipeline.
        useEffect(() => subscribeSttModelState(setSttModel), []);

        function handleChange(patch) {
            // Merge the patch onto the authoritative settings object (the single
            // source of truth ST persists), not a render-time React snapshot.
            // Object.assign is synchronous, so back-to-back calls in the same
            // tick each build on the previous write instead of clobbering it.
            const next = normalizeSettings({ ...extensionSettings[SETTINGS_KEY], ...patch });
            Object.assign(extensionSettings[SETTINGS_KEY], next);
            saveSettingsDebounced();
            setSettings(next);
        }

        return (
            <App
                settings={settings}
                onChange={handleChange}
                sttModel={sttModel}
                onLoadSttModel={() => loadSttModel(getModelUrl())}
            />
        );
    }

    const reactRoot = ReactDOM.createRoot(root);
    reactRoot.render(<Root />);
})();
