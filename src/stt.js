/* global SillyTavern */
// ---------------------------------------------------------------------------
// Speech-to-Text pipeline
//
// Intercepts the audio produced by SillyTavern's TTS, feeds it through
// Vosk Browser, and logs word-level timestamps to the console. These
// timestamps are the raw material for Live2D lip-sync.
//
// The Vosk model must be loaded MANUALLY by the user (via the settings UI)
// before any transcription happens — loading a model is expensive and we never
// want to trigger it implicitly from an incoming TTS event.
// ---------------------------------------------------------------------------
import * as Vosk from 'vosk-browser';

const MODULE = 'Live2D+ STT';

// Served path of the bundled default model (see models/ folder + README).
export const DEFAULT_VOSK_MODEL_URL =
    '/scripts/extensions/third-party/Extension-Live2D-Plus/models/vosk-model-small-en-us-0.15.tar.gz';

// Vosk internal log verbosity (-1 silences its own console spam).
const VOSK_LOG_LEVEL = -1;
const CHUNK_SECONDS = 0.25;
const FINAL_RESULT_TIMEOUT_MS = 15000;
const FINAL_RESULT_SETTLE_MS = 250;

// ---------------------------------------------------------------------------
// Model state (manual load required)
// ---------------------------------------------------------------------------

// state: 'idle' | 'loading' | 'ready' | 'error'
let modelState = { state: 'idle', message: '', modelUrl: '' };
let loadedModel = null;
let loadPromise = null;
const stateListeners = new Set();

function setModelState(next) {
    modelState = { ...modelState, ...next };
    for (const listener of stateListeners) {
        try { listener(modelState); } catch { /* noop */ }
    }
}

export function getSttModelState() {
    return modelState;
}

export function subscribeSttModelState(listener) {
    if (typeof listener !== 'function') return () => {};
    stateListeners.add(listener);
    listener(modelState);
    return () => stateListeners.delete(listener);
}

export function isSttModelReady() {
    return modelState.state === 'ready' && !!loadedModel;
}

function normalizeModelUrl(modelUrl) {
    return typeof modelUrl === 'string' && modelUrl.trim()
        ? modelUrl.trim()
        : DEFAULT_VOSK_MODEL_URL;
}

/**
 * Manually load (or reload) a Vosk model. Must be called before TTS audio can
 * be transcribed. Loading the same URL while ready is a no-op unless forced.
 * @param {string} modelUrl
 */
export async function loadSttModel(modelUrl) {
    const url = normalizeModelUrl(modelUrl);

    // Deduplicate concurrent load requests.
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        setModelState({ state: 'loading', message: `Loading model from ${url}…`, modelUrl: url });

        // Free any previously loaded model before swapping.
        if (loadedModel) {
            try { loadedModel.terminate?.(); } catch { /* noop */ }
            loadedModel = null;
        }

        try {
            const model = await Vosk.createModel(url, VOSK_LOG_LEVEL);
            loadedModel = model;
            setModelState({ state: 'ready', message: `Model ready — ${url}`, modelUrl: url });
            console.log(`[${MODULE}] Vosk model loaded from ${url}`);
        } catch (error) {
            loadedModel = null;
            const message = error?.message || 'Failed to load Vosk model.';
            setModelState({ state: 'error', message, modelUrl: url });
            console.error(`[${MODULE}] Failed to load Vosk model from ${url}:`, error);
        } finally {
            loadPromise = null;
        }
    })();

    return loadPromise;
}

// ---------------------------------------------------------------------------
// Audio decoding helpers
// ---------------------------------------------------------------------------

async function decodeAudioBlob(blob) {
    if (typeof window === 'undefined') {
        throw new Error('Vosk STT is only available in the browser.');
    }
    if (!blob || typeof blob.arrayBuffer !== 'function') {
        throw new Error('A browser audio Blob is required for Vosk transcription.');
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API is not available.');

    const audioContext = new AudioCtx();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } finally {
        try { audioContext.close(); } catch { /* noop */ }
    }
}

function mixAudioBufferToMono(audioBuffer) {
    if (!audioBuffer || audioBuffer.numberOfChannels < 1) {
        throw new Error('Decoded audio does not contain any channels.');
    }
    if (audioBuffer.numberOfChannels === 1) {
        return Float32Array.from(audioBuffer.getChannelData(0));
    }

    const mono = new Float32Array(audioBuffer.length);
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
        const data = audioBuffer.getChannelData(channel);
        for (let i = 0; i < audioBuffer.length; i += 1) {
            mono[i] += data[i] / audioBuffer.numberOfChannels;
        }
    }
    return mono;
}

function readChunkFrames(sampleRate) {
    return Math.max(1024, Math.round(sampleRate * CHUNK_SECONDS));
}

function yieldToBrowser() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function normalizeWord(entry) {
    const start = Number(entry?.start);
    const end = Number(entry?.end);
    const conf = Number(entry?.conf);
    const word = typeof entry?.word === 'string' ? entry.word.trim() : '';
    return {
        word,
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0),
        conf: Number.isFinite(conf) ? conf : null,
    };
}

// ---------------------------------------------------------------------------
// Recognizer result collection
//
// Vosk emits 'result' messages as it flushes segments. After we've pushed all
// audio we call retrieveFinalResult() and settle a short moment later to catch
// the trailing segment.
// ---------------------------------------------------------------------------

function collectRecognizerResult(recognizer) {
    const resultMessages = [];
    let resolveFn;
    let rejectFn;
    let timeoutId = 0;
    let settleId = 0;
    let finalRequested = false;

    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });

    const cleanup = () => {
        if (timeoutId) window.clearTimeout(timeoutId);
        if (settleId) window.clearTimeout(settleId);
    };
    const finish = () => {
        cleanup();
        resolveFn(resultMessages);
    };
    const fail = (error) => {
        cleanup();
        rejectFn(error instanceof Error ? error : new Error(String(error)));
    };
    const scheduleSettle = () => {
        if (settleId) window.clearTimeout(settleId);
        settleId = window.setTimeout(finish, FINAL_RESULT_SETTLE_MS);
    };

    recognizer.on('result', (message) => {
        resultMessages.push(message);
        if (finalRequested) scheduleSettle();
    });
    recognizer.on('error', (message) => {
        fail(new Error(message?.error || 'Vosk recognizer returned an error.'));
    });

    timeoutId = window.setTimeout(() => {
        fail(new Error('Timed out waiting for Vosk final result.'));
    }, FINAL_RESULT_TIMEOUT_MS);

    return {
        promise,
        requestFinal() {
            finalRequested = true;
            recognizer.retrieveFinalResult();
            // In case no further 'result' fires, settle anyway.
            scheduleSettle();
        },
    };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

async function transcribeBlob(blob) {
    if (!loadedModel) {
        throw new Error('Vosk model is not loaded. Load a model in the Live2D+ settings first.');
    }

    const audioBuffer = await decodeAudioBlob(blob);
    if (!audioBuffer?.sampleRate || !audioBuffer?.length) {
        throw new Error('Decoded audio is empty.');
    }

    const recognizer = new loadedModel.KaldiRecognizer(audioBuffer.sampleRate);
    recognizer.setWords(true);

    const collector = collectRecognizerResult(recognizer);
    const mono = mixAudioBufferToMono(audioBuffer);
    const chunkFrames = readChunkFrames(audioBuffer.sampleRate);

    try {
        for (let offset = 0, chunk = 0; offset < mono.length; offset += chunkFrames, chunk += 1) {
            recognizer.acceptWaveformFloat(mono.slice(offset, offset + chunkFrames), audioBuffer.sampleRate);
            // Yield periodically so we don't freeze the UI on long clips.
            if (chunk % 8 === 7) await yieldToBrowser();
        }

        collector.requestFinal();
        const resultMessages = await collector.promise;

        const words = resultMessages
            .flatMap((message) => (Array.isArray(message?.result?.result) ? message.result.result : []))
            .map(normalizeWord)
            .filter((entry) => entry.word);

        const text = resultMessages
            .map((message) => (typeof message?.result?.text === 'string' ? message.result.text.trim() : ''))
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim() || words.map((entry) => entry.word).join(' ');

        return {
            text,
            words,
            sampleRate: audioBuffer.sampleRate,
            duration: Number(audioBuffer.duration) || 0,
        };
    } finally {
        try { recognizer.remove(); } catch { /* noop */ }
    }
}

// ---------------------------------------------------------------------------
// TTS audio interception
//
// SillyTavern emits TTS_AUDIO_READY with the raw audio (a Blob, or sometimes a
// plain URL string) BEFORE it plays. We grab it there, transcribe it, and log
// the word timestamps. We do NOT block ST's own playback — the audio still
// plays normally; the lip-sync stage (later) will consume these timestamps.
// ---------------------------------------------------------------------------

let pipelineInstalled = false;

async function resolveAudioBlob(audio) {
    if (audio instanceof Blob) return audio;
    if (typeof audio === 'string') {
        const response = await fetch(audio);
        if (!response.ok) {
            throw new Error(`Failed to fetch TTS audio (${response.status}).`);
        }
        return response.blob();
    }
    return null;
}

function logTimestamps(characterName, text, words, duration) {
    const label = characterName ? `"${characterName}"` : 'TTS';
    console.groupCollapsed(`[${MODULE}] ${label} — ${words.length} words (${duration.toFixed(2)}s)`);
    console.log('Text:', text);
    if (words.length) {
        console.table(words.map((w) => ({
            word: w.word,
            start: w.start,
            end: w.end,
            conf: w.conf,
        })));
    } else {
        console.warn('No word-level timestamps were produced.');
    }
    console.groupEnd();
}

/**
 * Install the TTS interception + transcription pipeline. Safe to call once.
 * @param {object} opts
 * @param {() => boolean} opts.isEnabled  Live read of the STT enabled toggle.
 * @param {() => string}  opts.getModelUrl Live read of the configured model URL.
 */
export function setupSttPipeline({ isEnabled, getModelUrl } = {}) {
    if (pipelineInstalled) return;
    pipelineInstalled = true;

    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (!ctx) {
        console.error(`[${MODULE}] SillyTavern context not available; STT disabled.`);
        return;
    }

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes || ctx.event_types;
    const readyEvent = eventTypes?.TTS_AUDIO_READY;

    if (!eventSource || !readyEvent) {
        console.error(`[${MODULE}] TTS_AUDIO_READY event is unavailable; STT disabled.`);
        return;
    }

    eventSource.on(readyEvent, async ({ audio, text, characterName } = {}) => {
        if (typeof isEnabled === 'function' && !isEnabled()) return;

        // The model must be loaded manually beforehand.
        if (!isSttModelReady()) {
            console.warn(`[${MODULE}] TTS audio intercepted but no Vosk model is loaded. ` +
                'Load a model in the Live2D+ settings first.');
            return;
        }

        try {
            const blob = await resolveAudioBlob(audio);
            if (!blob) {
                console.warn(`[${MODULE}] Unrecognized TTS audio type:`, typeof audio);
                return;
            }

            const result = await transcribeBlob(blob);
            logTimestamps(characterName, result.text || text || '', result.words, result.duration);
        } catch (error) {
            console.error(`[${MODULE}] Failed to transcribe TTS audio:`, error);
        }
    });

    // Reference the getModelUrl option so it stays part of the documented API
    // even though loading is triggered explicitly from the settings UI.
    void getModelUrl;

    console.log(`[${MODULE}] TTS interception installed. Load a Vosk model to begin transcribing.`);
}
