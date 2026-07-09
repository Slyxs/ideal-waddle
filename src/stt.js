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

// ---------------------------------------------------------------------------
// Extension path detection
//
// SillyTavern serves extensions at /scripts/extensions/third-party/<folder>/.
// The folder name may differ from the repo name (e.g. the extension manager
// installs under an ID like "ideal-waddle"). We detect it from the script tag
// that loaded this bundle so the default model URL stays correct.
// ---------------------------------------------------------------------------

function detectExtensionFolder() {
    try {
        const current = document.currentScript;
        if (current?.src) {
            const match = current.src.match(/\/scripts\/extensions\/third-party\/([^/]+)(?:\/dist\/index\.js|$)/);
            if (match) return match[1];
        }

        const scripts = document.querySelectorAll('script[src*="/scripts/extensions/third-party/"]');
        for (const script of scripts) {
            const match = script.src.match(/\/scripts\/extensions\/third-party\/([^/]+)(?:\/dist\/index\.js|$)/);
            if (match) return match[1];
        }
    } catch {
        /* noop — document may not exist in test environments */
    }
    return 'Extension-Live2D-Plus';
}

const EXTENSION_FOLDER = detectExtensionFolder();
export const EXTENSION_WEB_PATH = `/scripts/extensions/third-party/${EXTENSION_FOLDER}`;

// Served path of the bundled default model (see models/ folder + README).
export const DEFAULT_VOSK_MODEL_URL =
    `${EXTENSION_WEB_PATH}/models/vosk-model-small-en-us-0.15.tar.gz`;

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

/**
 * Convert user-provided model locations into a fetchable SillyTavern URL.
 * Handles empty input, Android document/content URIs, double-encoded paths,
 * and local filesystem paths under SillyTavern's extensions folder.
 * @param {string} modelUrl
 */
function normalizeModelUrl(modelUrl) {
    let url = typeof modelUrl === 'string' ? modelUrl.trim() : '';
    if (!url) return DEFAULT_VOSK_MODEL_URL;

    // Decode over-encoded URI components, e.g. %252F -> %2F -> /
    while (url.includes('%25')) {
        const decoded = decodeURIComponent(url);
        if (decoded === url) break;
        url = decoded;
    }

    // Strip Android Storage Access Framework wrappers.
    if (url.startsWith('document://')) {
        url = url.slice('document://'.length);
    }
    if (url.startsWith('content://')) {
        // content://com.termux.documents/tree/<encoded-root>?<relative-path>
        const match = url.match(/tree\/(.+?)(?:\?|$)(.*)/);
        if (match) {
            url = `/${match[1].replace(/^\/+/, '')}${match[2] || ''}`;
        }
    }

    // If the user pasted a local filesystem path inside SillyTavern's
    // extensions folder, convert it to the web-served path.
    const localMatch = url.match(/\/extensions\/([^/]+)\/models\/([^/]+\.tar\.gz)$/i);
    if (localMatch) {
        return `/scripts/extensions/third-party/${localMatch[1]}/models/${localMatch[2]}`;
    }

    // Non-HTTP relative paths should be absolute so fetch() resolves them
    // against the site origin instead of the current page.
    if (!url.match(/^https?:\/\//i) && !url.startsWith('/')) {
        url = `/${url}`;
    }

    return url;
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
            let message = error?.message || 'Failed to load Vosk model.';
            if (message.toLowerCase().includes('fetch') || /^(document|content):/i.test(modelUrl)) {
                message = `${message}. Make sure the URL is a path SillyTavern can serve, e.g. ${DEFAULT_VOSK_MODEL_URL}`;
            }
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

/**
 * Resample decoded audio to 16 kHz mono using OfflineAudioContext.
 * Vosk models are trained on 16 kHz audio; feeding other rates often
 * transcribes fine but yields no word-level timestamps.
 */
async function resampleTo16kHzMono(audioBuffer) {
    const targetSampleRate = 16000;
    const targetLength = Math.max(1, Math.ceil(audioBuffer.duration * targetSampleRate));
    const OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineAudioContext) {
        throw new Error('OfflineAudioContext is not available for resampling.');
    }
    const offlineContext = new OfflineAudioContext(1, targetLength, targetSampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start(0);
    const rendered = await offlineContext.startRendering();
    return {
        sampleRate: targetSampleRate,
        duration: audioBuffer.duration,
        samples: Float32Array.from(rendered.getChannelData(0)),
    };
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

function normalizeResultMessage(message) {
    const result = message?.result || {};
    let rawWords = [];
    if (Array.isArray(result.result)) {
        rawWords = result.result;
    } else if (Array.isArray(result.words)) {
        rawWords = result.words;
    } else if (Array.isArray(message?.result)) {
        rawWords = message.result;
    }
    const words = rawWords.map(normalizeWord).filter((entry) => entry.word);
    const text = typeof result.text === 'string'
        ? result.text.trim()
        : (typeof message?.text === 'string' ? message.text.trim() : '');
    return { text, words };
}

function createApproximateAlignment(text, durationSeconds) {
    const characters = Array.from(typeof text === 'string' ? text : '');
    const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
        ? Number(durationSeconds)
        : 0;

    if (!characters.length) {
        return {
            characters: [],
            character_start_times_seconds: [],
            character_end_times_seconds: [],
            approximate: true,
            source: MODULE,
        };
    }

    const characterDuration = duration > 0 ? duration / characters.length : 0;
    return {
        characters,
        character_start_times_seconds: characters.map((_, index) => Number((index * characterDuration).toFixed(3))),
        character_end_times_seconds: characters.map((_, index) => Number(((index + 1) * characterDuration).toFixed(3))),
        approximate: true,
        source: MODULE,
    };
}

function createCharacterAlignmentFromWords(words, fallbackText, durationSeconds) {
    const normalizedWords = Array.isArray(words)
        ? words.map(normalizeWord).filter((entry) => entry.word)
        : [];

    if (!normalizedWords.length) {
        return createApproximateAlignment(fallbackText, durationSeconds);
    }

    const characters = [];
    const characterStartTimes = [];
    const characterEndTimes = [];
    let previousEnd = 0;

    normalizedWords.forEach((entry, wordIndex) => {
        const wordCharacters = Array.from(entry.word);
        const safeStart = Math.max(0, entry.start);
        const safeEnd = Math.max(safeStart, entry.end);
        const wordDuration = safeEnd - safeStart;

        if (wordIndex > 0) {
            characters.push(' ');
            characterStartTimes.push(Number(previousEnd.toFixed(3)));
            characterEndTimes.push(Number(Math.max(previousEnd, safeStart).toFixed(3)));
        }

        wordCharacters.forEach((character, index) => {
            const start = safeStart + (wordDuration * index) / Math.max(wordCharacters.length, 1);
            const end = safeStart + (wordDuration * (index + 1)) / Math.max(wordCharacters.length, 1);
            characters.push(character);
            characterStartTimes.push(Number(start.toFixed(3)));
            characterEndTimes.push(Number(end.toFixed(3)));
        });

        previousEnd = safeEnd;
    });

    return {
        characters,
        character_start_times_seconds: characterStartTimes,
        character_end_times_seconds: characterEndTimes,
        approximate: false,
        source: MODULE,
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
    const partialResults = [];
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
        resolveFn({ resultMessages, partialResults });
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
    recognizer.on('partialresult', (message) => {
        // We don't use partial results for file transcription, but keep them
        // for debugging in case word timestamps are missing.
        partialResults.push(message);
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

    // Vosk models are trained on 16 kHz mono. Transcription can work at other
    // rates, but word timestamps are usually missing unless the audio is
    // resampled to exactly 16 kHz before recognition.
    const {
        sampleRate: recognizerSampleRate,
        duration,
        samples: mono,
    } = await resampleTo16kHzMono(audioBuffer);

    const recognizer = new loadedModel.KaldiRecognizer(recognizerSampleRate);
    if (typeof recognizer.setWords === 'function') {
        recognizer.setWords(true);
        console.log(`[${MODULE}] Recognizer created at ${recognizerSampleRate} Hz with word timestamps enabled.`);
    } else {
        console.warn(`[${MODULE}] Recognizer has no setWords() method; word timestamps will not be available.`);
    }

    const collector = collectRecognizerResult(recognizer);
    const chunkFrames = readChunkFrames(recognizerSampleRate);

    try {
        for (let offset = 0, chunk = 0; offset < mono.length; offset += chunkFrames, chunk += 1) {
            recognizer.acceptWaveformFloat(mono.slice(offset, offset + chunkFrames), recognizerSampleRate);
            // Yield periodically so we don't freeze the UI on long clips.
            if (chunk % 8 === 7) await yieldToBrowser();
        }

        collector.requestFinal();
        const { resultMessages, partialResults } = await collector.promise;

        // Debug: if word timestamps are missing, log the raw Vosk messages so
        // we can see what shape the model is actually returning.
        const normalizedResults = resultMessages.map(normalizeResultMessage);
        const words = normalizedResults.flatMap((result) => result.words);
        const text = normalizedResults
            .map((result) => result.text)
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim() || words.map((entry) => entry.word).join(' ');

        const alignment = createCharacterAlignmentFromWords(words, text || '', duration);

        if (!words.length && resultMessages.length) {
            console.warn(`[${MODULE}] Vosk returned ${resultMessages.length} result segment(s) but no word timestamps. ` +
                'Raw results logged below.');
            console.log(`[${MODULE}] Raw Vosk result messages:`, resultMessages);
            console.log(`[${MODULE}] Partial results:`, partialResults);
        } else if (words.length) {
            console.log(`[${MODULE}] Produced ${words.length} word timestamp(s).`);
        }

        return {
            text,
            words,
            alignment,
            sampleRate: audioBuffer.sampleRate,
            duration,
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

function logTimestamps(characterName, text, words, alignment, duration) {
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
        console.warn('No word-level timestamps were produced; using approximate alignment.');
    }
    console.log('Alignment:', alignment);
    console.groupEnd();
}

// Event name used by Dustpan so external lip-sync consumers can pick this up.
const TTS_DYNAMIC_TIMESTAMPS_READY_EVENT = 'TTSDynamicTimestampsReady';

function dispatchTimestamps(characterName, text, words, alignment, duration) {
    if (typeof window === 'undefined') return;
    try {
        window.dispatchEvent(new CustomEvent(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, {
            detail: {
                provider: MODULE,
                characterName,
                text,
                words,
                alignment,
                normalizedAlignment: alignment,
                approximate: alignment?.approximate === true,
                duration,
            },
        }));
    } catch (err) {
        console.error(`[${MODULE}] Failed to dispatch timestamp event:`, err);
    }
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
            logTimestamps(characterName, result.text || text || '', result.words, result.alignment, result.duration);
            dispatchTimestamps(characterName, result.text || text || '', result.words, result.alignment, result.duration);
        } catch (error) {
            console.error(`[${MODULE}] Failed to transcribe TTS audio:`, error);
        }
    });

    // Reference the getModelUrl option so it stays part of the documented API
    // even though loading is triggered explicitly from the settings UI.
    void getModelUrl;

    console.log(`[${MODULE}] TTS interception installed. Load a Vosk model to begin transcribing.`);
}
