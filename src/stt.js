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
import { analyzeDynamicText, createNeutralDynamicSegments } from './dynamicAnalysis';

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
const URL_REVOKE_FALLBACK_MS = 120000;
const NATIVE_TTS_BLOCK_WINDOW_MS = 300000;
const SILLYTAVERN_TTS_AUDIO_ID = 'tts_audio';
const LIVE2D_ALLOWED_AUDIO_URLS_KEY = '__live2dPlusAllowedAudioUrls';

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
            console.log(`[${MODULE}] Creating Vosk model from ${url}...`);
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

    console.log(`[${MODULE}] Decoding audio blob: type=${blob.type}, size=${blob.size} bytes`);

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API is not available.');

    const audioContext = new AudioCtx();
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        console.log(`[${MODULE}] Audio decoded: ${decoded.sampleRate} Hz, ${decoded.numberOfChannels} channel(s), ${decoded.duration.toFixed(3)}s, ${decoded.length} samples`);
        return decoded;
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
// audio we call retrieveFinalResult() and wait for Vosk's final 'result' event;
// resolving earlier can remove the recognizer before timestamps are emitted.
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
        console.log(`[${MODULE}] Vosk 'result' event:`, message);
        resultMessages.push(message);
        if (finalRequested) scheduleSettle();
    });
    recognizer.on('partialresult', (message) => {
        console.log(`[${MODULE}] Vosk 'partialresult' event:`, message);
        // We don't use partial results for file transcription, but keep them
        // for debugging in case word timestamps are missing.
        partialResults.push(message);
    });
    recognizer.on('error', (message) => {
        console.error(`[${MODULE}] Vosk 'error' event:`, message);
        fail(new Error(message?.error || 'Vosk recognizer returned an error.'));
    });

    timeoutId = window.setTimeout(() => {
        fail(new Error('Timed out waiting for Vosk final result.'));
    }, FINAL_RESULT_TIMEOUT_MS);

    return {
        promise,
        requestFinal() {
            finalRequested = true;
            console.log(`[${MODULE}] Requesting final Vosk result...`);
            recognizer.retrieveFinalResult();
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

    console.log(`[${MODULE}] Starting transcription of blob: type=${blob.type}, size=${blob.size} bytes`);

    const audioBuffer = await decodeAudioBlob(blob);
    if (!audioBuffer?.sampleRate || !audioBuffer?.length) {
        throw new Error('Decoded audio is empty.');
    }

    // Pass the decoded audio to Vosk at its native sample rate. Vosk resamples
    // internally and timestamps are more reliable when we let it handle the
    // original buffer instead of pre-resampling with OfflineAudioContext.
    const recognizerSampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const mono = mixAudioBufferToMono(audioBuffer);

    const recognizer = new loadedModel.KaldiRecognizer(recognizerSampleRate);
    if (typeof recognizer.setWords === 'function') {
        recognizer.setWords(true);
        console.log(`[${MODULE}] Recognizer created at ${recognizerSampleRate} Hz with word timestamps enabled.`);
    } else {
        console.warn(`[${MODULE}] Recognizer has no setWords() method; word timestamps will not be available.`);
    }

    const collector = collectRecognizerResult(recognizer);
    const chunkFrames = readChunkFrames(recognizerSampleRate);
    const totalChunks = Math.ceil(mono.length / chunkFrames);

    try {
        console.log(`[${MODULE}] Feeding ${totalChunks} chunk(s) of ${chunkFrames} frames each.`);
        for (let offset = 0, chunk = 0; offset < mono.length; offset += chunkFrames, chunk += 1) {
            recognizer.acceptWaveformFloat(mono.slice(offset, offset + chunkFrames), recognizerSampleRate);
            // Yield periodically so we don't freeze the UI on long clips.
            if (chunk % 8 === 7) await yieldToBrowser();
        }

        collector.requestFinal();
        const { resultMessages, partialResults } = await collector.promise;

        console.log(`[${MODULE}] Vosk returned ${resultMessages.length} result segment(s) and ${partialResults.length} partial result(s).`);

        // Debug: if word timestamps are missing, log the raw Vosk messages so
        // we can see what shape the model is actually returning.
        const normalizedResults = resultMessages.map(normalizeResultMessage);
        let words = normalizedResults.flatMap((result) => result.words);
        let text = normalizedResults
            .map((result) => result.text)
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim() || words.map((entry) => entry.word).join(' ');

        // Fallback: if the final result is empty but partial results exist,
        // Vosk recognized something but never flushed a final segment. Use the
        // last partial transcript so the lip-sync pipeline still gets text.
        if (!text && partialResults.length) {
            const lastPartial = partialResults[partialResults.length - 1];
            const partialText = typeof lastPartial?.result?.partial === 'string'
                ? lastPartial.result.partial.trim()
                : '';
            if (partialText) {
                console.warn(`[${MODULE}] Vosk produced no final result; falling back to last partial transcript.`);
                text = partialText;
            }
        }

        console.log(`[${MODULE}] Extracted text: "${text}"`);
        console.log(`[${MODULE}] Extracted ${words.length} word timestamp(s):`, words);

        const alignment = createCharacterAlignmentFromWords(words, text || '', duration);

        if (!words.length && resultMessages.length) {
            console.warn(`[${MODULE}] Vosk returned ${resultMessages.length} result segment(s) but no word timestamps. ` +
                'Raw results logged below.');
            console.log(`[${MODULE}] Raw Vosk result messages:`, resultMessages);
            console.log(`[${MODULE}] Partial results:`, partialResults);
        } else if (!words.length && partialResults.length) {
            console.warn(`[${MODULE}] Vosk returned partial results but no word timestamps. ` +
                'The model may not support word timestamps, or the audio format prevented extraction.');
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
// the word timestamps. When routed to Live2D, ST's own media element is muted,
// stopped, and sent an 'ended' event so its queue keeps moving.
// ---------------------------------------------------------------------------

let pipelineInstalled = false;
let playbackInterceptorInstalled = false;
let shouldBlockNativePlayback = () => false;
let originalMediaPlay = null;
let nativeTtsBlockUntil = 0;
const mutedMediaState = new WeakMap();
const nativeTtsSourceUrls = new Set();

function normalizeMediaUrl(url) {
    const value = typeof url === 'string' ? url.trim() : '';
    if (!value) return '';
    try {
        const anchor = document.createElement('a');
        anchor.href = value;
        return anchor.href;
    } catch {
        return value;
    }
}

function getAllowedLive2DAudioUrls() {
    if (typeof window === 'undefined') return null;
    if (!(window[LIVE2D_ALLOWED_AUDIO_URLS_KEY] instanceof Set)) {
        window[LIVE2D_ALLOWED_AUDIO_URLS_KEY] = new Set();
    }
    return window[LIVE2D_ALLOWED_AUDIO_URLS_KEY];
}

function isAllowedLive2DAudioElement(element) {
    const allowedUrls = getAllowedLive2DAudioUrls();
    if (!allowedUrls) return false;
    const src = normalizeMediaUrl(element?.currentSrc || element?.src || '');
    return !!src && allowedUrls.has(src);
}

function markNativeTtsSource(audio) {
    if (typeof audio !== 'string') return;
    const src = normalizeMediaUrl(audio);
    if (src) nativeTtsSourceUrls.add(src);
}

function startNativeTtsBlockWindow(audio) {
    markNativeTtsSource(audio);
    nativeTtsBlockUntil = Date.now() + NATIVE_TTS_BLOCK_WINDOW_MS;
}

function isNativeTtsAudioElement(element) {
    if (!element || isAllowedLive2DAudioElement(element)) return false;
    if (element.id === SILLYTAVERN_TTS_AUDIO_ID) return true;

    const src = normalizeMediaUrl(element.currentSrc || element.src || '');
    if (src && nativeTtsSourceUrls.has(src)) return true;

    return Date.now() < nativeTtsBlockUntil;
}

function rememberMediaState(element) {
    if (!element || mutedMediaState.has(element)) return;
    mutedMediaState.set(element, {
        muted: element.muted === true,
        volume: Number.isFinite(Number(element.volume)) ? Number(element.volume) : 1,
    });
}

function restoreMediaState(element) {
    const state = mutedMediaState.get(element);
    if (!state) return;
    try { element.muted = state.muted; } catch { /* noop */ }
    try { element.volume = state.volume; } catch { /* noop */ }
    mutedMediaState.delete(element);
}

function stopNativeTtsMediaElement(element, reason = 'blocked') {
    rememberMediaState(element);
    try { element.muted = true; } catch { /* noop */ }
    try { element.volume = 0; } catch { /* noop */ }
    try { element.pause?.(); } catch { /* noop */ }
    try {
        if (Number.isFinite(element.currentTime)) element.currentTime = 0;
    } catch { /* noop */ }

    console.log(`[${MODULE}] Prevented SillyTavern native TTS playback (${reason}).`);
    Promise.resolve().then(() => {
        try { element.dispatchEvent(new Event('ended')); } catch { /* noop */ }
    });
}

function installNativeTtsPlaybackBlocker() {
    const MediaElement = typeof HTMLMediaElement !== 'undefined'
        ? HTMLMediaElement
        : (typeof HTMLAudioElement !== 'undefined' ? HTMLAudioElement : null);
    if (playbackInterceptorInstalled || !MediaElement) return;
    playbackInterceptorInstalled = true;
    originalMediaPlay = MediaElement.prototype.play;
    MediaElement.prototype.play = function patchedLive2DPlusPlay() {
        if (shouldBlockNativePlayback() && isNativeTtsAudioElement(this)) {
            stopNativeTtsMediaElement(this, 'play() guard');
            return Promise.resolve();
        }
        if (this?.id === SILLYTAVERN_TTS_AUDIO_ID) restoreMediaState(this);
        return originalMediaPlay.apply(this, arguments);
    };
}

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

async function readBlobDuration(blob) {
    try {
        const audioBuffer = await decodeAudioBlob(blob);
        const duration = Number(audioBuffer?.duration);
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
    } catch (error) {
        console.warn(`[${MODULE}] Could not read audio duration for approximate alignment:`, error);
        return 0;
    }
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

function dispatchTimestamps({ characterName, text, words, alignment, duration, blobUrl, analysis, segments }) {
    if (typeof window === 'undefined') return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        let fallbackTimer = 0;
        const settle = (accepted) => {
            if (settled) return;
            settled = true;
            if (fallbackTimer) window.clearTimeout(fallbackTimer);
            resolve(accepted === true);
        };
        const detail = {
            accepted: false,
            provider: MODULE,
            characterName,
            text,
            words,
            blobUrl,
            timestamps: alignment,
            alignment,
            normalizedAlignment: alignment,
            approximate: alignment?.approximate === true,
            duration,
            segments,
            analysisModel: analysis?.model || null,
            analysisSource: analysis?.source || null,
            analysisTemperature: analysis?.temperature ?? null,
            rawAnalysisText: analysis?.rawResponseText || '',
            parsedAnalysis: analysis?.parsed || null,
            analysisError: analysis?.error || null,
            analysisSkipped: analysis?.skipped === true,
            resolve: () => settle(true),
            reject: (error) => {
                if (error) console.error(`[${MODULE}] Live2D dynamic playback rejected:`, error);
                settle(true);
            },
        };

        try {
            window.dispatchEvent(new CustomEvent(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, { detail }));
            if (!detail.accepted) settle(false);
            else if (!settled) fallbackTimer = window.setTimeout(() => settle(true), URL_REVOKE_FALLBACK_MS);
        } catch (err) {
            console.error(`[${MODULE}] Failed to dispatch timestamp event:`, err);
            settle(false);
        }
    });
}

/**
 * Install the TTS interception + transcription pipeline. Safe to call once.
 * @param {object} opts
 * @param {() => boolean} opts.isEnabled  Live read of the STT enabled toggle.
 * @param {() => string}  opts.getModelUrl Live read of the configured model URL.
 * @param {() => object}  opts.getSettings Live read of all Live2D+ settings.
 */
export function setupSttPipeline({ isEnabled, getModelUrl, getSettings } = {}) {
    if (pipelineInstalled) return;
    pipelineInstalled = true;

    installNativeTtsPlaybackBlocker();
    shouldBlockNativePlayback = () => {
        const settings = typeof getSettings === 'function' ? getSettings() : {};
        return settings.enabled === true
            && settings.routeTtsToLive2D === true
            && settings.blockOriginalTtsPlayback === true
            && !!window.live2dPlusModel?.speak;
    };

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
        console.log(`[${MODULE}] TTS_AUDIO_READY fired for character="${characterName || ''}", audio type=`, typeof audio, audio);

        const settings = typeof getSettings === 'function' ? getSettings() : {};
        const sttEnabled = typeof isEnabled === 'function' ? isEnabled() : settings.sttEnabled === true;
        const routeToLive2D = settings.enabled === true && settings.routeTtsToLive2D === true;

        if (routeToLive2D && settings.blockOriginalTtsPlayback === true) {
            startNativeTtsBlockWindow(audio);
        }

        if (!sttEnabled && !routeToLive2D) {
            console.log(`[${MODULE}] STT is disabled in settings; skipping transcription.`);
            return;
        }

        let blobUrl = '';
        try {
            const blob = await resolveAudioBlob(audio);
            if (!blob) {
                console.warn(`[${MODULE}] Unrecognized TTS audio type:`, typeof audio);
                return;
            }
            console.log(`[${MODULE}] Resolved TTS audio to blob: type=${blob.type}, size=${blob.size} bytes`);

            blobUrl = URL.createObjectURL(blob);
            let result;
            if (sttEnabled && isSttModelReady()) {
                result = await transcribeBlob(blob);
            } else {
                if (sttEnabled) {
                    console.warn(`[${MODULE}] TTS audio intercepted but no Vosk model is loaded. ` +
                        'Using approximate timing for Live2D playback.');
                }
                const duration = await readBlobDuration(blob);
                const fallbackText = typeof text === 'string' ? text : '';
                result = {
                    text: fallbackText,
                    words: [],
                    alignment: createApproximateAlignment(fallbackText, duration),
                    sampleRate: null,
                    duration,
                };
            }

            const finalText = result.text || text || '';
            const analysis = settings.dynamicMode === true
                ? await analyzeDynamicText(finalText, settings)
                : { segments: createNeutralDynamicSegments(finalText, settings), skipped: true };
            const segments = Array.isArray(analysis?.segments) && analysis.segments.length
                ? analysis.segments
                : createNeutralDynamicSegments(finalText, settings);

            logTimestamps(characterName, finalText, result.words, result.alignment, result.duration);
            const accepted = await dispatchTimestamps({
                characterName,
                text: finalText,
                words: result.words,
                alignment: result.alignment,
                duration: result.duration,
                blobUrl,
                analysis,
                segments,
            });
            if (!accepted && blobUrl) {
                URL.revokeObjectURL(blobUrl);
                blobUrl = '';
            }
        } catch (error) {
            console.error(`[${MODULE}] Failed to transcribe TTS audio:`, error);
            if (blobUrl) URL.revokeObjectURL(blobUrl);
        }
    });

    // Reference the getModelUrl option so it stays part of the documented API
    // even though loading is triggered explicitly from the settings UI.
    void getModelUrl;

    console.log(`[${MODULE}] TTS interception installed. Load a Vosk model to begin transcribing.`);
}
