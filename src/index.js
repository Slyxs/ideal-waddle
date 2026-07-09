/* global SillyTavern */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// ---------------------------------------------------------------------------
// Interception state — shared between the event handler and the React UI
// ---------------------------------------------------------------------------
let interceptEnabled = false;

export function setInterceptEnabled(value) {
    interceptEnabled = value;
}

export function getInterceptEnabled() {
    return interceptEnabled;
}

// ---------------------------------------------------------------------------
// HTMLAudioElement.prototype.play patch
//
// ST's audio element is never appended to the DOM, but it does have
// id="tts_audio" set on it, which we use as the filter.
//
// When we block play() we must also manually dispatch 'ended' so ST's
// internal completeCurrentAudioJob() fires and the audio queue keeps moving.
// ---------------------------------------------------------------------------
const _originalPlay = HTMLAudioElement.prototype.play;
HTMLAudioElement.prototype.play = function () {
    if (this.id === 'tts_audio' && interceptEnabled) {
        const el = this;
        // Unblock ST's queue on the next microtask tick
        Promise.resolve().then(() => el.dispatchEvent(new Event('ended')));
        return Promise.resolve();
    }
    return _originalPlay.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// TTS_AUDIO_READY listener — fires with the raw Blob BEFORE playback
// ---------------------------------------------------------------------------
function setupTtsIntercept() {
    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(eventTypes.TTS_AUDIO_READY, ({ audio, text, characterName }) => {
        if (!interceptEnabled) return;

        let url;
        if (audio instanceof Blob) {
            // createObjectURL gives a real blob: URL the Live2D library can consume
            url = URL.createObjectURL(audio);
        } else if (typeof audio === 'string') {
            // Some providers (e.g. ElevenLabs CDN) return a plain URL already
            url = audio;
        } else {
            console.warn('[Live2D TTS] Unrecognised audio type:', typeof audio);
            return;
        }

        console.log('[Live2D TTS] Intercepted audio URL for "' + characterName + '":', url);
        console.log('[Live2D TTS] Text:', text);
        // TODO: hand url + text to Live2D lipsync & Vosk
        // When done, call URL.revokeObjectURL(url) to free memory (Blob URLs only)
    });
}

setupTtsIntercept();

// ---------------------------------------------------------------------------
// React UI
// ---------------------------------------------------------------------------
const rootContainer = document.getElementById('extensions_settings');
const rootElement = document.createElement('div');
rootContainer.appendChild(rootElement);

const root = ReactDOM.createRoot(rootElement);
root.render(
    <React.StrictMode>
        <App
            getEnabled={getInterceptEnabled}
            setEnabled={setInterceptEnabled}
        />
    </React.StrictMode>
);
