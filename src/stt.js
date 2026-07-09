/* global SillyTavern */
// ---------------------------------------------------------------------------
// Speech-to-text (Vosk) pipeline
//
// Intercepts the audio that SillyTavern's TTS produces, runs it through the
// Vosk Browser recognizer, and logs word-level timestamps to the console.
// These timestamps are the raw material for real lip-sync (feeding mouth
// open/close values to the Live2D model over time).
//
// Interception is done via the `TTS_AUDIO_READY` event, which fires with the
// raw audio (Blob or URL) *before* SillyTavern plays it back — see
// https://docs.sillytavern.app/for-contributors/writing-extensions/#events
// ---------------------------------------------------------------------------

import * as Vosk from 'vosk-browser';

const MODULE_NAME = 'Live2D+ STT';
const EXTENSION_FOLDER = 'Extension-Live2D-Plus';
const EXTENSION_WEB_PATH = `/scripts/extensions/third-party/${EXTENSION_FOLDER}`;

// Default model shipped in this extension's `models/` folder. Users can drop
// their own `.tar.gz` models there and point `voskModelUrl` at them.
export const DEFAULT_VOSK_MODEL_URL =
    `${EXTENSION_WEB_PATH}/models/vosk-model-small-en-us-0.15.tar.gz`;

const VOSK_LOG_LEVEL = -1;
const CHUNK_SECONDS = 0.25;
const FINAL_RESULT_TIMEOUT_MS = 15000;
const FINAL_RESULT_SETTLE_MS = 250;

// ---------------------------------------------------------------------------
// Model loading (cached per URL)
// ---------------------------------------------------------------------------

let modelPromise = null;
let modelUrlInUse = '';

function normalizeModelUrl(modelUrl) {
    return typeof modelUrl === 'string' && modelUrl.trim()
        ? modelUrl.trim()
        : DEFAULT_VOSK_MODEL_URL;
}

export function loadVoskModel(modelUrl = DEFAULT_VOSK_MODEL_URL) {
    const nextModelUrl = normalizeModelUrl(modelUrl);
    if (!modelPromise || modelUrlInUse !== nextModelUrl) {
        if (modelPromise) {
            modelPromise.then((model) => model?.terminate?.()).catch(() => {});
        }
        modelUrlInUse = nextModelUrl;
        console.log(`[${MODULE_NAME}] Loading Vosk model: ${nextModelUrl}`);
        modelPromise = Vosk.createModel(nextModelUrl, VOSK_LOG_LEVEL)
            .then((model) => {
                console.log(`[${MODULE_NAME}] Vosk model ready.`);
                return model;
            })
            .catch((error) => {
                if (modelUrlInUse === nextModelUrl) {
                    modelPromise = null;
                    modelUrlInUse = '';
                }
                throw error instanceof Error ? error : new Error('Failed to load Vosk model.');
            });
    }
    return modelPromise;
}

// ---------------------------------------------------------------------------
// Audio decoding helpers
// ---------------------------------------------------------------------------

function getAudioContextCtor() {
    return window.AudioContext || window.webkitAudioContext || null;
}

async function decodeAudioBlob(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') {
        throw new Error('A browser audio Blob is required for Vosk transcription.');
    }
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) throw new Error('Web Audio API is not available.');

    const audioContext = new AudioCtx();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        return await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } finally {
        try { audioContext.close(); } catch { /* noop */ }
    }
}

function mixToMono(audioBuffer) {
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

function yieldToBrowser() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Result normalization
// ---------------------------------------------------------------------------

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

function normalizeResultMessage(message) {
    const result = message?.result || {};
    const words = Array.isArray(result.result)
        ? result.result.map(normalizeWord).filter((entry) => entry.word)
        : [];
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    return { text, words };
}

// Collect `result` messages from the recognizer, then resolve once the final
// result has settled (Vosk emits results incrementally).
function waitForRecognizerResult(recognizer, timeoutMs = FINAL_RESULT_TIMEOUT_MS) {
    const resultMessages = [];
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });

    let timeoutId = 0;
    let settleId = 0;
    let finalRequested = false;

    const cleanup = () => {
        if (timeoutId) window.clearTimeout(timeoutId);
        if (settleId) window.clearTimeout(settleId);
    };
    const finish = () => {
        cleanup();
        resolveFn({ resultMessages });
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
        cleanup();
        rejectFn(new Error(message?.error || 'Vosk recognizer returned an error.'));
    });

    timeoutId = window.setTimeout(() => {
        cleanup();
        rejectFn(new Error('Timed out while waiting for Vosk final transcription result.'));
    }, Math.max(1000, Number(timeoutMs) || FINAL_RESULT_TIMEOUT_MS));

    return {
        promise,
        requestFinalResult() {
            finalRequested = true;
            recognizer.retrieveFinalResult();
        },
    };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Transcribe a decoded AudioBuffer with Vosk and return word-level timestamps.
 * @returns {Promise<{ text: string, words: Array<{word,start,end,conf}>, duration: number }>}
 */
export async function transcribeAudioBuffer(audioBuffer, { modelUrl } = {}) {
    if (!audioBuffer?.sampleRate || !audioBuffer?.length) {
        throw new Error('A decoded AudioBuffer is required for Vosk transcription.');
    }

    const model = await loadVoskModel(modelUrl);
    const recognizer = new model.KaldiRecognizer(audioBuffer.sampleRate);
    recognizer.setWords(true);

    const finalResult = waitForRecognizerResult(recognizer);
    const monoSamples = mixToMono(audioBuffer);
    const chunkFrames = Math.max(1024, Math.round(audioBuffer.sampleRate * CHUNK_SECONDS));

    try {
        for (let offset = 0; offset < monoSamples.length; offset += chunkFrames) {
            recognizer.acceptWaveformFloat(
                monoSamples.slice(offset, offset + chunkFrames),
                audioBuffer.sampleRate,
            );
            // Yield periodically so the UI thread stays responsive.
            if ((offset / chunkFrames) % 8 === 7) await yieldToBrowser();
        }

        finalResult.requestFinalResult();
        const { resultMessages } = await finalResult.promise;

        const normalized = resultMessages.map(normalizeResultMessage);
        const words = normalized.flatMap((result) => result.words);
        const text = normalized.map((result) => result.text).filter(Boolean).join(' ').trim()
            || words.map((entry) => entry.word).join(' ').trim();

        return { text, words, duration: Number(audioBuffer.duration) || 0 };
    } finally {
        try { recognizer.remove(); } catch { /* noop */ }
    }
}

/** Transcribe an audio Blob. */
export async function transcribeAudioBlob(blob, options = {}) {
    const audioBuffer = await decodeAudioBlob(blob);
    return transcribeAudioBuffer(audioBuffer, options);
}

/** Transcribe audio referenced by a URL (fetches it first). */
export async function transcribeAudioUrl(url, options = {}) {
    if (!url) throw new Error('An audio URL is required for Vosk transcription.');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch audio for Vosk transcription (${response.status}).`);
    }
    const blob = await response.blob();
    return transcribeAudioBlob(blob, options);
}

// ---------------------------------------------------------------------------
// TTS audio interception → transcription → console log
// ---------------------------------------------------------------------------

/**
 * Install the STT pipeline. Listens for TTS audio and, while enabled, runs it
 * through Vosk and logs word-level timestamps.
 *
 * @param {object} options
 * @param {() => boolean} options.isEnabled  Returns whether STT is active.
 * @param {() => string}  [options.getModelUrl]  Returns the Vosk model URL.
 * @returns {() => void}  Teardown function that removes the listener.
 */
export function setupSttPipeline({ isEnabled, getModelUrl } = {}) {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (!ctx?.eventSource) {
        console.error(`[${MODULE_NAME}] SillyTavern event source not available.`);
        return () => {};
    }

    const { eventSource, eventTypes } = ctx;
    const readyEvent = (eventTypes || ctx.event_types)?.TTS_AUDIO_READY;
    if (!readyEvent) {
        console.error(`[${MODULE_NAME}] TTS_AUDIO_READY event is not available in this SillyTavern version.`);
        return () => {};
    }

    const handler = async ({ audio, text, characterName } = {}) => {
        if (typeof isEnabled === 'function' && !isEnabled()) return;

        const modelUrl = typeof getModelUrl === 'function' ? getModelUrl() : DEFAULT_VOSK_MODEL_URL;

        // The event delivers either a Blob (most providers) or a plain URL
        // string (e.g. some CDN-backed providers).
        let blobUrl = null;
        try {
            let result;
            if (audio instanceof Blob) {
                result = await transcribeAudioBlob(audio, { modelUrl });
            } else if (typeof audio === 'string') {
                result = await transcribeAudioUrl(audio, { modelUrl });
            } else {
                console.warn(`[${MODULE_NAME}] Unrecognised audio type:`, typeof audio);
                return;
            }

            console.groupCollapsed(
                `[${MODULE_NAME}] Timestamps for "${characterName || 'TTS'}" (${result.words.length} words, ${result.duration.toFixed(2)}s)`,
            );
            console.log('Text (TTS):', text);
            console.log('Transcript (Vosk):', result.text);
            console.table(result.words.map((w) => ({
                word: w.word,
                start: w.start,
                end: w.end,
                conf: w.conf,
            })));
            console.log('Raw words:', result.words);
            console.groupEnd();
        } catch (error) {
            console.error(`[${MODULE_NAME}] Transcription failed:`, error);
        } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        }
    };

    eventSource.on(readyEvent, handler);
    console.log(`[${MODULE_NAME}] Listening for TTS audio.`);

    return () => {
        eventSource.removeListener?.(readyEvent, handler);
    };
}
