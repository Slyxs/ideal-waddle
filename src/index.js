/* global SillyTavern */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { normalizeSettings, defaultSettings } from './live2d/settings';

// ─────────────────────────────────────────────────────────────────────────────
// Settings persistence via ST's extension_settings
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'live2d_tts';

function loadSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extension_settings[SETTINGS_KEY]) {
        ctx.extension_settings[SETTINGS_KEY] = { ...defaultSettings };
    }
    return ctx.extension_settings[SETTINGS_KEY];
}

function saveSettings(settings) {
    const ctx = SillyTavern.getContext();
    ctx.extension_settings[SETTINGS_KEY] = settings;
    ctx.saveSettingsDebounced?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTMLAudioElement.prototype.play patch
//
// When Live2D is enabled we block ST's tts_audio playback so we can feed the
// audio to the Live2D lipsync layer instead.  A synthetic 'ended' event is
// dispatched so ST's internal audio queue keeps moving.
// ─────────────────────────────────────────────────────────────────────────────

const _originalPlay = HTMLAudioElement.prototype.play;

HTMLAudioElement.prototype.play = function () {
    if (this.id === 'tts_audio' && isInterceptActive()) {
        const el = this;
        Promise.resolve().then(() => el.dispatchEvent(new Event('ended')));
        return Promise.resolve();
    }
    return _originalPlay.apply(this, arguments);
};

function isInterceptActive() {
    try {
        const settings = normalizeSettings(SillyTavern.getContext().extension_settings[SETTINGS_KEY]);
        return settings.enabled;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS_AUDIO_READY listener
// ─────────────────────────────────────────────────────────────────────────────

function setupTtsIntercept() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(eventTypes.TTS_AUDIO_READY, ({ audio, text, characterName }) => {
        if (!isInterceptActive()) return;

        let url;
        if (audio instanceof Blob) {
            url = URL.createObjectURL(audio);
        } else if (typeof audio === 'string') {
            url = audio;
        } else {
            console.warn('[Live2D TTS] Unrecognised audio type:', typeof audio);
            return;
        }

        console.log('[Live2D TTS] Intercepted audio for "' + characterName + '"');
        console.log('[Live2D TTS] Text:', text);
        console.log('[Live2D TTS] Blob URL:', url);
        // TODO: feed url + text to Vosk for timestamps, then drive lipsync
        // Remember to call URL.revokeObjectURL(url) once done (Blob URLs only)
    });
}

setupTtsIntercept();

// ─────────────────────────────────────────────────────────────────────────────
// React root
// ─────────────────────────────────────────────────────────────────────────────

function mountApp() {
    const rootContainer =
        document.getElementById('extensions_settings') ||
        document.getElementById('extensions_settings2');

    if (!rootContainer) {
        console.error('[Live2D TTS] Could not find extensions_settings container – extension UI will not be shown.');
        return;
    }

    const rootElement = document.createElement('div');
    rootContainer.appendChild(rootElement);

    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <App
                loadSettings={loadSettings}
                saveSettings={saveSettings}
            />
        </React.StrictMode>,
    );
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountApp);
} else {
    mountApp();
}
