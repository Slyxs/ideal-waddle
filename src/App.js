import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ANALYSIS_SOURCES, normalizeSettings, resolveModelUrl, MODEL_SOURCES, CAPTION_STYLE_OPTIONS } from './settings';
import { EXTENSION_WEB_PATH } from './stt';
import { loadLive2DRuntime, buildFilters, applyModelTransform, applyModelInteraction, muteModelMotionAudio } from './live2d';
import { createLive2DCaptionController } from './captions';
import {
    LIVE2D_PLUS_SETTINGS_STYLES,
    CheckboxRow,
    Slider,
    formatNumber,
    ColorInput,
    SubDrawer,
    MotionTestSection,
    DynamicSettingsSection,
    TapInteractionsSection,
    getMotionLabel,
    getExpressionLabel,
} from './ui';

// ---------------------------------------------------------------------------
// Dynamic Live2D playback helpers
// ---------------------------------------------------------------------------

const TTS_DYNAMIC_TIMESTAMPS_READY_EVENT = 'TTSDynamicTimestampsReady';
const LIVE2D_MODEL_INFO_EVENT = 'Live2DPlusModelInfoChanged';
const LIVE2D_MOTION_PRIORITY_FORCE = 3;
const DEFAULT_STATE_RESET_DELAY_MS = 1800;
const DRAG_START_THRESHOLD_PX = 4;
// Window (ms) after a drag ends during which the model's trailing tap/click
// event is ignored so releasing a drag never fires a tap interaction.
const DRAG_TAP_SUPPRESSION_MS = 350;
const LIVE2D_PLUS_NO_IDLE_GROUP = '__live2dPlusNoIdleAfterPlayback__';
let sillyTavernScriptPromise = null;

function readNeutralEmotion(settings = {}) {
    const labels = Array.isArray(settings.emotionLabels) ? settings.emotionLabels : [];
    return labels.find((label) => String(label).toLowerCase() === 'neutral') || labels[0] || 'Neutral';
}

function normalizePlaybackSegments(detail, settings) {
    const source = Array.isArray(detail?.segments) && detail.segments.length > 0
        ? detail.segments
        : [{ emotion: readNeutralEmotion(settings), action: null, text: detail?.text || '' }];

    return source.map((segment) => ({
        emotion: typeof segment?.emotion === 'string' && segment.emotion.trim()
            ? segment.emotion.trim()
            : readNeutralEmotion(settings),
        action: typeof segment?.action === 'string' && segment.action.trim() ? segment.action.trim() : null,
        text: typeof segment?.text === 'string' ? segment.text : '',
        startTime: Number.isFinite(Number(segment?.startTime)) ? Number(segment.startTime) : null,
        endTime: Number.isFinite(Number(segment?.endTime)) ? Number(segment.endTime) : null,
        duration: Number.isFinite(Number(segment?.duration)) ? Number(segment.duration) : null,
    }));
}

function pickAlignment(detail) {
    return detail?.alignment || detail?.timestamps || detail?.normalizedAlignment || null;
}

function readAlignmentDuration(alignment) {
    const endTimes = Array.isArray(alignment?.character_end_times_seconds)
        ? alignment.character_end_times_seconds
        : [];
    const last = Number(endTimes[endTimes.length - 1]);
    return Number.isFinite(last) ? last : 0;
}

function distributeSegmentsByTextLength(segments, duration) {
    const totalChars = segments.reduce((count, segment) => count + Array.from(segment.text || '').length, 0);
    const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
        ? Number(duration)
        : Math.max(segments.length, 1);
    let cursor = 0;

    return segments.map((segment, index) => {
        if (segment.startTime != null && segment.endTime != null) {
            return { ...segment, duration: Math.max(0, segment.endTime - segment.startTime) };
        }

        const charCount = Array.from(segment.text || '').length || 1;
        const segmentDuration = totalChars > 0
            ? (charCount / totalChars) * safeDuration
            : safeDuration / Math.max(segments.length, 1);
        const startTime = cursor;
        const isLast = index === segments.length - 1;
        const endTime = isLast ? safeDuration : cursor + segmentDuration;
        cursor = endTime;
        return { ...segment, startTime, endTime, duration: Math.max(0, endTime - startTime) };
    });
}

function calculatePlaybackTimeline(detail, settings) {
    const segments = normalizePlaybackSegments(detail, settings);
    const alignment = pickAlignment(detail);
    const characters = Array.isArray(alignment?.characters) ? alignment.characters : [];
    const startTimes = Array.isArray(alignment?.character_start_times_seconds)
        ? alignment.character_start_times_seconds
        : [];
    const endTimes = Array.isArray(alignment?.character_end_times_seconds)
        ? alignment.character_end_times_seconds
        : [];
    const alignmentText = characters.join('');
    const segmentText = segments.map((segment) => segment.text).join('');

    if (characters.length > 0 && startTimes.length >= characters.length && endTimes.length >= characters.length && alignmentText === segmentText) {
        let charCursor = 0;
        return segments.map((segment) => {
            const charLength = Array.from(segment.text || '').length;
            const startIndex = charCursor;
            const endIndex = Math.max(startIndex, charCursor + charLength - 1);
            charCursor += charLength;
            const startTime = Number(startTimes[startIndex]) || 0;
            const endTime = Number(endTimes[endIndex]) || startTime;
            return { ...segment, startTime, endTime, duration: Math.max(0, endTime - startTime) };
        });
    }

    const duration = Number(detail?.duration) || readAlignmentDuration(alignment);
    return distributeSegmentsByTextLength(segments, duration);
}

function parseMotionValue(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text || text === 'null') return null;
    const separatorIndex = text.lastIndexOf(':');
    if (separatorIndex < 0) return null;
    const groupName = text.slice(0, separatorIndex);
    const motionIndex = Number.parseInt(text.slice(separatorIndex + 1), 10);
    if (!Number.isInteger(motionIndex) || motionIndex < 0) return null;
    return { groupName, motionIndex };
}

function readMotionDefinitions(model) {
    const settings = model?.internalModel?.settings || {};
    return settings.motions || model?.internalModel?.motionManager?.definitions || {};
}

function resolveMotionLabel(model, motionValue) {
    const parsedMotion = parseMotionValue(motionValue);
    if (!parsedMotion) return '';
    const definitions = readMotionDefinitions(model);
    const groupMotions = Array.isArray(definitions?.[parsedMotion.groupName]) ? definitions[parsedMotion.groupName] : [];
    const motion = groupMotions[parsedMotion.motionIndex];
    return getMotionLabel(motion, parsedMotion.motionIndex);
}

function resolveExpressionLabel(model, expressionValue) {
    const expressionIndex = Number.parseInt(expressionValue, 10);
    if (!Number.isInteger(expressionIndex)) return '';
    const settings = model?.internalModel?.settings || {};
    const source = settings.expressions || model?.internalModel?.motionManager?.expressionManager?.definitions || [];
    const expressions = Array.isArray(source)
        ? source
        : source && typeof source === 'object'
            ? Object.values(source).filter(Boolean)
            : [];
    return getExpressionLabel(expressions[expressionIndex], expressionIndex);
}

function readMappingByLabel(mappings, label) {
    const key = typeof label === 'string' ? label.trim() : '';
    if (!key || !mappings || typeof mappings !== 'object') return null;
    if (mappings[key]) return mappings[key];
    const lowerKey = key.toLowerCase();
    const matchedKey = Object.keys(mappings).find((mappingKey) => mappingKey.toLowerCase() === lowerKey);
    return matchedKey ? mappings[matchedKey] : null;
}

function resolveMappedCue(settings, segment) {
    const emotionKey = typeof segment?.emotion === 'string' ? segment.emotion.trim() : '';
    const actionKey = typeof segment?.action === 'string' ? segment.action.trim() : '';
    const emotionMapping = readMappingByLabel(settings.emotionMappings, emotionKey);
    const actionsEnabled = settings.analysisSource !== ANALYSIS_SOURCES.SILLYTAVERN_CLASSIFIER;
    const actionMapping = actionsEnabled && actionKey && Array.isArray(settings.actionMappings)
        ? settings.actionMappings.find((action) => action.description === actionKey)
        : null;
    const disabled = settings.disableSettings || {};
    const priorityList = Array.isArray(settings.priorityList) ? settings.priorityList : [];
    let motion = '';
    let expression = '';

    for (const item of priorityList.slice().sort((left, right) => right.priority - left.priority)) {
        if (actionsEnabled && item.type === 'action' && item.target === 'motion' && !motion && !disabled.actionMotions) {
            const candidate = actionMapping?.motion || '';
            if (candidate && candidate !== 'null') motion = candidate;
        }
        if (item.type === 'emotion' && item.target === 'expression' && !expression && !disabled.emotionExpressions) {
            const candidate = emotionMapping?.expression || '';
            if (candidate) expression = candidate;
        }
        if (item.type === 'emotion' && item.target === 'motion' && !motion && !disabled.emotionMotions) {
            const candidate = emotionMapping?.motion || '';
            if (candidate && candidate !== 'null') motion = candidate;
        }
        if (actionsEnabled && item.type === 'action' && item.target === 'expression' && !expression && !disabled.actionExpressions) {
            const candidate = actionMapping?.expression || '';
            if (candidate) expression = candidate;
        }
    }

    return {
        motion,
        expression,
        emotionMappingFound: !!emotionMapping,
        actionMappingFound: !!actionMapping,
        actionsEnabled,
    };
}

function getMotionManager(model) {
    return model?.internalModel?.motionManager || null;
}

function suppressIdleMotionRestart(model) {
    const state = getMotionManager(model)?.state;
    if (!state) return;

    try {
        state.setReservedIdle?.(LIVE2D_PLUS_NO_IDLE_GROUP, -1);
        return;
    } catch { /* noop */ }

    try {
        state.reservedIdleGroup = LIVE2D_PLUS_NO_IDLE_GROUP;
        state.reservedIdleIndex = -1;
    } catch { /* noop */ }
}

function stopModelMotionsOnly(model) {
    const motionManager = getMotionManager(model);
    try { model?.stopMotions?.(); } catch { /* noop */ }
    try { motionManager?.stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?._stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.queueManager?.stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.state?.reset?.(); } catch { /* noop */ }
    try { motionManager?.stopSpeaking?.(); } catch { /* noop */ }
    try { motionManager.playing = false; } catch { /* noop */ }
}

function stopModelMotionQueuesOnly(model) {
    const motionManager = getMotionManager(model);
    try { motionManager?._stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.queueManager?.stopAllMotions?.(); } catch { /* noop */ }
    try { motionManager?.state?.reset?.(); } catch { /* noop */ }
    try { motionManager.playing = false; } catch { /* noop */ }
}

function resetModelExpression(model) {
    const expressionManager = model?.internalModel?.motionManager?.expressionManager;
    if (!expressionManager) return;

    try { expressionManager.reserveExpressionIndex = -1; } catch { /* noop */ }
    try { expressionManager.stopAllExpressions?.(); } catch { /* noop */ }
    try {
        if (expressionManager.defaultExpression) {
            expressionManager.currentExpression = expressionManager.defaultExpression;
        }
    } catch { /* noop */ }

    if (typeof expressionManager?.resetExpression === 'function') {
        try { expressionManager.resetExpression(); return; } catch { /* noop */ }
    }
    try { model?.expression?.(0); } catch { /* noop */ }
}

function readMotionDurationMs(motion, fallbackMs = DEFAULT_STATE_RESET_DELAY_MS) {
    const rawDuration = [
        motion?.duration,
        motion?._duration,
        typeof motion?.getDuration === 'function' ? motion.getDuration() : null,
    ]
        .map((value) => Number(value))
        .find((value) => Number.isFinite(value) && value > 0);

    if (!Number.isFinite(rawDuration)) return fallbackMs;
    const durationMs = rawDuration > 100 ? rawDuration : rawDuration * 1000;
    return Math.min(Math.max(Math.round(durationMs), 250), 60000);
}

function resetDynamicState(model, { suppressIdle = true } = {}) {
    stopModelMotionsOnly(model);
    resetModelExpression(model);
    if (suppressIdle) suppressIdleMotionRestart(model);
}

async function startMotionWithoutInterruptingAudio(model, parsedMotion, options = {}) {
    const motionManager = getMotionManager(model);
    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    if (!motionManager || typeof motionManager.loadMotion !== 'function' || typeof motionManager._startMotion !== 'function') {
        console.warn('[Live2D Dynamic] Motion manager cannot start a cue without interrupting audio.');
        return false;
    }

    const definitions = readMotionDefinitions(model);
    const groupMotions = Array.isArray(definitions?.[parsedMotion.groupName]) ? definitions[parsedMotion.groupName] : [];
    if (!groupMotions[parsedMotion.motionIndex]) {
        console.warn('[Live2D Dynamic] Motion mapping points to an unavailable motion:', {
            ...parsedMotion,
            availableGroups: Object.keys(definitions),
        });
        return false;
    }

    if (!shouldContinue()) return false;

    try {
        stopModelMotionQueuesOnly(model);
        if (!shouldContinue()) return false;
        if (typeof motionManager.state?.reserve === 'function') {
            const reserved = motionManager.state.reserve(parsedMotion.groupName, parsedMotion.motionIndex, LIVE2D_MOTION_PRIORITY_FORCE);
            if (!reserved) return false;
        }

        const motion = await motionManager.loadMotion(parsedMotion.groupName, parsedMotion.motionIndex);
        if (!motion || !shouldContinue()) return false;

        if (typeof motionManager.state?.start === 'function') {
            const started = motionManager.state.start(motion, parsedMotion.groupName, parsedMotion.motionIndex, LIVE2D_MOTION_PRIORITY_FORCE);
            if (!started) return false;
        }

        motionManager.playing = true;
        try { motionManager.emit?.('motionStart', parsedMotion.groupName, parsedMotion.motionIndex, null); } catch { /* noop */ }
        motionManager._startMotion(motion);
        return true;
    } catch (error) {
        console.error('[Live2D Dynamic] Motion failed:', error);
        return false;
    }
}

async function applyDynamicCue(model, settings, segment, options = {}) {
    if (!model) return null;
    const shouldContinue = typeof options.shouldContinue === 'function' ? options.shouldContinue : () => true;
    const resolvedCue = resolveMappedCue(settings, segment);
    const { motion, expression } = resolvedCue;
    const cue = {
        emotion: segment?.emotion || '',
        action: segment?.action || null,
        text: segment?.text || '',
        motion,
        motionLabel: resolveMotionLabel(model, motion),
        expression,
        expressionLabel: resolveExpressionLabel(model, expression),
        emotionMappingFound: resolvedCue.emotionMappingFound,
        actionMappingFound: resolvedCue.actionMappingFound,
        actionsEnabled: resolvedCue.actionsEnabled,
        appliedMotion: false,
        appliedExpression: false,
    };

    if (!shouldContinue()) return cue;

    if (expression !== '') {
        const expressionIndex = Number.parseInt(expression, 10);
        if (Number.isInteger(expressionIndex)) {
            try {
                const result = model.expression?.(expressionIndex);
                cue.appliedExpression = await Promise.resolve(result).then((value) => shouldContinue() && value !== false);
            } catch (error) {
                console.error('[Live2D Dynamic] Expression failed:', error);
            }
        }
    }

    const parsedMotion = parseMotionValue(motion);
    if (parsedMotion) {
        cue.appliedMotion = await startMotionWithoutInterruptingAudio(model, parsedMotion, options);
    }

    return cue;
}

function describeDynamicCue(cue) {
    if (!cue) return 'none';
    const motion = cue.motion ? `${cue.motion}${cue.motionLabel ? ` (${cue.motionLabel})` : ''}` : 'none';
    const expression = cue.expression ? `${cue.expression}${cue.expressionLabel ? ` (${cue.expressionLabel})` : ''}` : 'none';
    return `emotion="${cue.emotion || ''}" action="${cue.action || 'none'}" motion=${motion} expression=${expression} appliedMotion=${cue.appliedMotion === true} appliedExpression=${cue.appliedExpression === true}`;
}

function getSillyTavernContext() {
    return typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function'
        ? SillyTavern.getContext()
        : null;
}

function getSillyTavernScriptUrl() {
    if (typeof document !== 'undefined') {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        const script = scripts.find((scriptEl) => {
            try {
                return new URL(scriptEl.src, window.location.href).pathname.endsWith('/script.js');
            } catch {
                return /(?:^|\/)script\.js(?:$|[?#])/.test(scriptEl.getAttribute('src') || '');
            }
        });
        if (script?.src) return script.src;
    }

    return '/script.js';
}

function loadSillyTavernScriptModule() {
    if (!sillyTavernScriptPromise) {
        sillyTavernScriptPromise = import(/* webpackIgnore: true */ getSillyTavernScriptUrl());
    }

    return sillyTavernScriptPromise;
}

function normalizeHitAreaNames(hitAreas) {
    return Array.isArray(hitAreas)
        ? hitAreas.map((hitArea) => String(hitArea || '').trim()).filter(Boolean)
        : [];
}

function hasTapMappingValue(mapping) {
    return !!(mapping?.motion || mapping?.expression || mapping?.message);
}

function readTapAreaMapping(tapInteractions, hitArea) {
    const mappings = tapInteractions?.hitAreaMappings || {};
    return mappings[hitArea.id] || mappings[hitArea.name] || {};
}

function resolveTapInteractionMapping(model, settings, hitAreas = []) {
    const tapInteractions = settings?.tapInteractions || {};
    const tappedAreas = new Set(normalizeHitAreaNames(hitAreas));
    const hitAreaDefinitions = normalizeRuntimeHitAreas(model?.internalModel?.hitAreas);
    const mappedHitArea = hitAreaDefinitions
        .filter((hitArea) => tappedAreas.has(hitArea.id) || tappedAreas.has(hitArea.name))
        .map((hitArea) => ({ hitArea, mapping: readTapAreaMapping(tapInteractions, hitArea) }))
        .filter(({ mapping }) => hasTapMappingValue(mapping))
        .sort((left, right) => left.hitArea.index - right.hitArea.index || left.hitArea.name.localeCompare(right.hitArea.name))[0];

    if (mappedHitArea) {
        return { ...mappedHitArea.mapping, hitArea: mappedHitArea.hitArea };
    }

    return { ...(tapInteractions.defaultMapping || {}), hitArea: null };
}

async function sendTapInteractionMessage(messageText, settings, previousInteractionRef) {
    const message = typeof messageText === 'string' ? messageText.trim() : '';
    if (!message) return false;

    const context = getSillyTavernContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const lastMessage = chat[chat.length - 1];
    if (lastMessage?.is_user && previousInteractionRef.current?.message === message) {
        console.debug('[Live2D+ Tap] Same interaction as latest user message; skipping duplicate send.');
        return false;
    }

    previousInteractionRef.current = { message };

    try { window.$?.('#send_textarea')?.val?.(''); } catch { /* noop */ }

    const scriptModule = await loadSillyTavernScriptModule();
    if (typeof scriptModule?.sendMessageAsUser !== 'function') {
        throw new Error('SillyTavern sendMessageAsUser is not available.');
    }

    await scriptModule.sendMessageAsUser(message);

    if (settings?.tapInteractions?.autoSend) {
        const liveContext = getSillyTavernContext();
        await liveContext?.generate?.();
    }

    return true;
}

async function playTapInteractionMotion(model, motionValue) {
    const parsedMotion = parseMotionValue(motionValue);
    if (!parsedMotion || !model?.motion) return false;

    try {
        const result = model.motion(parsedMotion.groupName, parsedMotion.motionIndex, undefined, { volume: 0 });
        return await Promise.resolve(result).then((value) => value !== false);
    } catch (error) {
        console.error('[Live2D+ Tap] Motion failed:', error);
        return false;
    }
}

async function playTapInteractionExpression(model, expressionValue) {
    const expressionIndex = Number.parseInt(expressionValue, 10);
    if (!Number.isInteger(expressionIndex) || !model?.expression) return false;

    try {
        const result = model.expression(expressionIndex);
        return await Promise.resolve(result).then((value) => value !== false);
    } catch (error) {
        console.error('[Live2D+ Tap] Expression failed:', error);
        return false;
    }
}

async function applyTapInteraction(model, settings, mapping, previousInteractionRef) {
    if (!model || !hasTapMappingValue(mapping)) return;

    try {
        await sendTapInteractionMessage(mapping.message, settings, previousInteractionRef);
    } catch (error) {
        console.error('[Live2D+ Tap] Message send failed:', error);
    }
    await playTapInteractionExpression(model, mapping.expression);
    await playTapInteractionMotion(model, mapping.motion);
}

function readPointerGlobalPoint(event) {
    const point = event?.global || event?.data?.global;
    const x = Number(point?.x);
    const y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function readPointerHitAreas(model, event) {
    const point = readPointerGlobalPoint(event);
    if (!point || typeof model?.hitTest !== 'function') return [];

    try {
        const hitAreas = await model.hitTest(point.x, point.y);
        return normalizeHitAreaNames(hitAreas);
    } catch (error) {
        console.error('[Live2D+ Tap] Hit test failed:', error);
        return [];
    }
}

async function decodePlaybackBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API is not available.');
    const ctx = new AudioCtx();
    try {
        return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
        try { ctx.close(); } catch { /* noop */ }
    }
}

function audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numChannels * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    let pos = 0;

    function setUint16(value) { view.setUint16(pos, value, true); pos += 2; }
    function setUint32(value) { view.setUint32(pos, value, true); pos += 4; }

    setUint32(0x46464952);
    setUint32(length - 8);
    setUint32(0x45564157);
    setUint32(0x20746d66);
    setUint32(16);
    setUint16(1);
    setUint16(numChannels);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numChannels);
    setUint16(numChannels * 2);
    setUint16(16);
    setUint32(0x61746164);
    setUint32(length - pos - 4);

    const channels = [];
    for (let channel = 0; channel < numChannels; channel += 1) channels.push(audioBuffer.getChannelData(channel));

    let offset = 0;
    while (pos < length) {
        for (let channel = 0; channel < numChannels; channel += 1) {
            let sample = Math.max(-1, Math.min(1, channels[channel][offset] || 0));
            sample = (sample < 0 ? sample * 32768 : sample * 32767) | 0;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset += 1;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function sliceAudioBufferToWavBlob(audioBuffer, startTime, endTime) {
    const sampleRate = audioBuffer.sampleRate;
    const totalFrames = audioBuffer.length;
    const startFrame = Math.max(0, Math.min(totalFrames, Math.floor(Number(startTime) * sampleRate)));
    const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil(Number(endTime) * sampleRate)));
    const frameCount = endFrame - startFrame;
    if (frameCount <= 0) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    try {
        const part = ctx.createBuffer(audioBuffer.numberOfChannels, frameCount, sampleRate);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
            const src = audioBuffer.getChannelData(channel);
            const dst = part.getChannelData(channel);
            for (let sample = 0; sample < frameCount; sample += 1) dst[sample] = src[startFrame + sample] || 0;
        }
        return audioBufferToWavBlob(part);
    } finally {
        try { ctx.close(); } catch { /* noop */ }
    }
}

async function buildSegmentAudioUrls(blobUrl, timeline) {
    if (!blobUrl || !Array.isArray(timeline) || timeline.length === 0) return [];
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    const audioBuffer = await decodePlaybackBlob(blob);
    const totalDuration = audioBuffer.duration;

    return timeline.map((segment, index) => {
        const rawStart = Number(segment.startTime);
        const rawEnd = Number(segment.endTime);
        const start = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
        const isLast = index === timeline.length - 1;
        let end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : totalDuration;
        if (isLast) end = totalDuration;
        const wavBlob = sliceAudioBufferToWavBlob(audioBuffer, start, end);
        if (!wavBlob) return { segment, url: null, start, end };
        return { segment, url: URL.createObjectURL(wavBlob), start, end };
    });
}

function normalizeRuntimeMotions(source) {
    const motions = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    return Object.fromEntries(
        Object.entries(motions)
            .map(([groupName, groupMotions]) => [groupName, Array.isArray(groupMotions) ? groupMotions : []])
            .filter(([, groupMotions]) => groupMotions.length > 0)
    );
}

function normalizeRuntimeExpressions(source) {
    if (Array.isArray(source)) return source;
    if (Array.isArray(source?.definitions)) return source.definitions;
    if (source && typeof source === 'object') return Object.values(source).filter(Boolean);
    return [];
}

function normalizeRuntimeHitAreas(source) {
    if (Array.isArray(source)) {
        return source
            .map((area, index) => {
                const id = area?.id || area?.Id || area?.name || area?.Name || `hit-area-${index + 1}`;
                const name = area?.name || area?.Name || area?.id || area?.Id || id;
                const rawIndex = Number(area?.index);
                return {
                    id: String(id),
                    name: String(name),
                    index: Number.isFinite(rawIndex) ? rawIndex : index,
                };
            })
            .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
    }

    const hitAreas = source && typeof source === 'object' ? source : {};
    return Object.entries(hitAreas)
        .map(([key, area]) => {
            const id = area?.name || area?.Name || key;
            const name = area?.name || area?.Name || key;
            const rawIndex = Number(area?.index);
            return {
                id: String(id),
                name: String(name),
                index: Number.isFinite(rawIndex) ? rawIndex : 9999,
            };
        })
        .sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
}

function readRuntimeModelInfo(model) {
    const internalSettings = model?.internalModel?.settings || {};
    const hitAreaSource = model?.internalModel?.hitAreas
        || internalSettings.hitAreas
        || internalSettings.hit_areas
        || [];

    return {
        name: model ? internalSettings.name || 'Active Model' : '',
        motions: normalizeRuntimeMotions(internalSettings.motions || model?.internalModel?.motionManager?.definitions),
        expressions: normalizeRuntimeExpressions(
            internalSettings.expressions || model?.internalModel?.motionManager?.expressionManager?.definitions
        ),
        hitAreas: normalizeRuntimeHitAreas(hitAreaSource),
    };
}

function dispatchRuntimeModelInfo(model) {
    if (typeof window === 'undefined') return;
    const detail = readRuntimeModelInfo(model);
    window.live2dPlusModelInfo = detail;
    window.dispatchEvent(new CustomEvent(LIVE2D_MODEL_INFO_EVENT, { detail }));
    console.log('[Live2D+] Runtime model info:', detail);
}

// ---------------------------------------------------------------------------
// Live2D Canvas — rendered as a portal to document.body
// ---------------------------------------------------------------------------

function Live2DCanvas({ settings, onPositionCommit }) {
    const rootRef = useRef(null);
    const containerRef = useRef(null);
    const appRef = useRef(null);
    const modelRef = useRef(null);
    const rendererRef = useRef(null);
    const currentSettingsRef = useRef(settings);
    const dragStateRef = useRef(null);
    const activeLipsyncRef = useRef(null);
    const stateResetTimerRef = useRef(0);
    const captionControllerRef = useRef(null);
    const previousInteractionRef = useRef({ message: '' });
    const tapEventGuardRef = useRef({ key: '', time: 0 });
    const justDraggedRef = useRef(0);
    const [status, setStatus] = useState({ state: 'loading', message: 'Initializing...' });
    const [pos, setPos] = useState({ x: settings.positionX, y: settings.positionY });

    useEffect(() => {
        currentSettingsRef.current = settings;
    }, [settings]);

    const clearPendingStateReset = useCallback(() => {
        if (stateResetTimerRef.current && typeof window !== 'undefined') {
            window.clearTimeout(stateResetTimerRef.current);
        }
        stateResetTimerRef.current = 0;
    }, []);

    const resetModelStateAfterPlayback = useCallback((model = modelRef.current) => {
        clearPendingStateReset();
        const liveSettings = currentSettingsRef.current;
        if (!model || liveSettings?.resetExpressionAfterPlayback === false) return;
        resetDynamicState(model);
    }, [clearPendingStateReset]);

    const stopActiveLipsync = useCallback(() => {
        activeLipsyncRef.current?.stop?.();
        activeLipsyncRef.current = null;
        captionControllerRef.current?.clear();
        resetModelStateAfterPlayback();
    }, [resetModelStateAfterPlayback]);

    useEffect(() => clearPendingStateReset, [clearPendingStateReset]);

    useEffect(() => {
        const controller = createLive2DCaptionController(rootRef.current);
        captionControllerRef.current = controller;
        controller?.updateSettings(settings);
        return () => {
            controller?.destroy();
            captionControllerRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        captionControllerRef.current?.updateSettings(settings);
    }, [settings]);

    // Sync position from settings when not dragging
    useEffect(() => {
        if (!dragStateRef.current) {
            setPos((current) => (
                current.x === settings.positionX && current.y === settings.positionY
                    ? current
                    : { x: settings.positionX, y: settings.positionY }
            ));
        }
    }, [settings.positionX, settings.positionY]);

    useEffect(() => () => {
        dragStateRef.current?.cleanup?.();
        dragStateRef.current = null;
    }, []);

    // Apply filters to active model
    const applyFilters = useCallback((s) => {
        const model = modelRef.current;
        const PIXI = rendererRef.current?.PIXI || window.PIXI;
        if (!model || !PIXI) return;
        const filters = buildFilters(s, PIXI);
        model.filters = filters.length > 0 ? filters : null;
    }, []);

    const handleTapAreas = useCallback((hitAreas = []) => {
        const model = modelRef.current;
        const liveSettings = currentSettingsRef.current || settings;
        if (!model || liveSettings?.tapInteractions?.enabled === false) return;

        // A pointer release that ends a drag also fires the model's tap/click
        // events. Ignore those so dragging the model never sends a tap message.
        if (dragStateRef.current?.dragging) return;
        if (Date.now() - justDraggedRef.current < DRAG_TAP_SUPPRESSION_MS) return;

        const normalizedHitAreas = normalizeHitAreaNames(hitAreas);
        const key = normalizedHitAreas.slice().sort().join('|') || '__default__';
        const now = Date.now();
        const lastEvent = tapEventGuardRef.current;
        if (lastEvent.key === key && now - lastEvent.time < 150) return;
        tapEventGuardRef.current = { key, time: now };

        const mapping = resolveTapInteractionMapping(model, liveSettings, normalizedHitAreas);
        const hasMapping = hasTapMappingValue(mapping);

        console.log('[Live2D+ Tap] Model touched:', {
            hitAreas: normalizedHitAreas,
            selectedHitArea: mapping.hitArea?.name || 'default',
            mapped: hasMapping,
            motion: mapping.motion || '',
            expression: mapping.expression || '',
            hasMessage: !!mapping.message,
        });

        if (!hasMapping) return;

        applyTapInteraction(model, liveSettings, mapping, previousInteractionRef)
            .catch((error) => console.error('[Live2D+ Tap] Interaction failed:', error));
    }, [settings]);

    const attachTapInteractionHandlers = useCallback((model) => {
        if (!model || typeof model.on !== 'function') return () => {};

        const handleHit = (hitAreas) => handleTapAreas(hitAreas);
        const handlePointerTap = (event) => {
            readPointerHitAreas(model, event)
                .then(handleTapAreas)
                .catch((error) => console.error('[Live2D+ Tap] Pointer tap failed:', error));
        };

        model.on('hit', handleHit);
        model.on('pointertap', handlePointerTap);
        model.on('click', handlePointerTap);

        return () => {
            try { model.off?.('hit', handleHit); } catch { /* noop */ }
            try { model.off?.('pointertap', handlePointerTap); } catch { /* noop */ }
            try { model.off?.('click', handlePointerTap); } catch { /* noop */ }
        };
    }, [handleTapAreas]);

    // Model load effect
    const modelUrl = resolveModelUrl(settings);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !modelUrl) {
            if (!modelUrl) setStatus({ state: 'error', message: 'No model URL configured.' });
            return;
        }

        let cancelled = false;

        function destroyCurrent() {
            const hadRuntimeModel = !!modelRef.current || !!window.live2dPlusModel;
            if (modelRef.current) {
                try { modelRef.current.__live2dPlusTapCleanup?.(); } catch (_) { /* noop */ }
                try { modelRef.current.destroy?.(); } catch (_) { /* noop */ }
                modelRef.current = null;
            }
            window.live2dPlusModel = null;
            if (hadRuntimeModel) dispatchRuntimeModelInfo(null);
            if (appRef.current) {
                try { appRef.current.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (_) { /* noop */ }
                appRef.current = null;
            }
        }

        destroyCurrent();
        setStatus({ state: 'loading', message: 'Loading model...' });

        (async () => {
            try {
                const runtime = await loadLive2DRuntime();
                if (cancelled) return;

                const { PIXI, Live2DModel } = runtime;
                rendererRef.current = runtime;

                const app = new PIXI.Application({
                    transparent: true,
                    backgroundAlpha: 0,
                    autoStart: true,
                    width: settings.canvasWidth,
                    height: settings.canvasHeight,
                });
                app.stage.eventMode = 'static';
                app.stage.hitArea = app.screen;
                appRef.current = app;

                // PIXI owns its own canvas; we append it to a container div.
                // This lets us fully destroy/recreate the canvas (and its WebGL
                // context) on model reloads without touching React's DOM, and
                // avoids leaking WebGL contexts on size changes (see resize effect).
                const view = app.view;
                view.style.display = 'block';
                view.style.width = '100%';
                view.style.height = '100%';
                view.style.pointerEvents =
                    settings.enableHitTesting || settings.followCursor || settings.tapInteractions?.enabled ? 'auto' : 'none';
                container.appendChild(view);

                const model = Live2DModel.fromSync(modelUrl, {
                    autoFocus: !!settings.followCursor,
                    autoHitTest: !!settings.enableHitTesting || !!settings.tapInteractions?.enabled,
                });

                if (cancelled) { model.destroy?.(); return; }
                modelRef.current = model;

                model.once('load', () => {
                    if (cancelled) { model.destroy?.(); return; }
                    app.stage.addChild(model);
                    model.alpha = settings.opacity;
                    applyModelTransform(model, settings);
                    applyModelInteraction(model, settings);
                    muteModelMotionAudio(model);
                    applyFilters(settings);
                    model.__live2dPlusTapCleanup = attachTapInteractionHandlers(model);
                    window.live2dPlusModel = model;
                    dispatchRuntimeModelInfo(model);
                    setStatus({ state: 'ready', message: 'Ready' });
                });

                model.once?.('error', (err) => {
                    if (cancelled) return;
                    destroyCurrent();
                    setStatus({ state: 'error', message: err?.message || 'Failed to load model.' });
                });
            } catch (err) {
                if (cancelled) return;
                destroyCurrent();
                setStatus({ state: 'error', message: err?.message || 'Failed to load runtime.' });
            }
        })();

        return () => {
            cancelled = true;
            destroyCurrent();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelUrl, settings.reloadKey]);

    // Canvas resize effect — resize the renderer in place instead of
    // destroying/recreating the whole PIXI app (which leaked WebGL contexts
    // and eventually stopped rendering entirely).
    useEffect(() => {
        const app = appRef.current;
        if (app?.renderer) {
            app.renderer.resize(settings.canvasWidth, settings.canvasHeight);
            app.stage.hitArea = app.screen;
            applyModelTransform(modelRef.current, settings);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.canvasWidth, settings.canvasHeight]);

    // Transform effect
    useEffect(() => {
        applyModelTransform(modelRef.current, settings);
    }, [settings.scale, settings.modelPositionX, settings.modelPositionY, settings.canvasWidth, settings.canvasHeight]);

    // Interaction effect
    useEffect(() => {
        applyModelInteraction(modelRef.current, settings);
        const view = appRef.current?.view;
        if (view?.style) {
            view.style.pointerEvents =
                settings.enableHitTesting || settings.followCursor || settings.tapInteractions?.enabled ? 'auto' : 'none';
        }
    }, [settings.followCursor, settings.enableHitTesting, settings.tapInteractions?.enabled]);

    // Filters effect
    const filtersKey = JSON.stringify({ f: settings.filters, p: settings.filterParams });
    useEffect(() => {
        applyFilters(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applyFilters, filtersKey]);

    // Opacity effect
    useEffect(() => {
        if (modelRef.current) modelRef.current.alpha = settings.opacity;
    }, [settings.opacity]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;

        const handleDynamicTimestampsReady = (event) => {
            const detail = event.detail || {};
            const liveSettings = currentSettingsRef.current || settings;
            console.log('[Live2D+ Dynamic] Event received:', {
                routeTtsToLive2D: liveSettings.routeTtsToLive2D,
                dynamicMode: liveSettings.dynamicMode,
                hasBlobUrl: !!detail.blobUrl,
                text: detail.text || '',
                segments: detail.segments || [],
                approximate: detail.approximate === true,
            });

            if (!liveSettings.routeTtsToLive2D || !detail.blobUrl) return;

            const model = modelRef.current;
            if (!model?.speak) {
                console.warn('[Live2D+ Dynamic] Model is not ready for playback.');
                return;
            }

            detail.accepted = true;

            stopActiveLipsync();

            let settled = false;
            const segmentUrls = [];
            const timeline = calculatePlaybackTimeline(detail, liveSettings);
            const releaseSegmentUrls = () => {
                while (segmentUrls.length) {
                    const url = segmentUrls.pop();
                    if (url) {
                        try { URL.revokeObjectURL(url); } catch { /* noop */ }
                    }
                }
            };
            const cleanup = ({ reset = false } = {}) => {
                detail.signal?.removeEventListener?.('abort', handleAbort);
                if (reset) resetModelStateAfterPlayback(model);
                releaseSegmentUrls();
                if (detail.blobUrl) {
                    try { URL.revokeObjectURL(detail.blobUrl); } catch { /* noop */ }
                    detail.blobUrl = '';
                }
                if (activeLipsyncRef.current?.finish === finish) activeLipsyncRef.current = null;
            };
            const finish = () => {
                if (settled) return;
                console.log('[Live2D+ Dynamic] Playback finished.');
                settled = true;
                captionControllerRef.current?.finish();
                cleanup({ reset: true });
                detail.resolve?.();
            };
            const fail = (error) => {
                if (settled) return;
                console.error('[Live2D+ Dynamic] Playback failed:', error);
                settled = true;
                captionControllerRef.current?.clear();
                cleanup({ reset: true });
                detail.reject?.(error);
            };
            const stop = () => {
                if (settled) return;
                console.log('[Live2D+ Dynamic] Playback stopped.');
                try { model.stopSpeaking?.(); } catch { /* noop */ }
                finish();
            };
            const handleAbort = () => stop();

            if (detail.signal?.aborted) {
                finish();
                return;
            }

            activeLipsyncRef.current = { finish, fail, stop };
            detail.signal?.addEventListener?.('abort', handleAbort, { once: true });
            console.log('[Live2D+ Dynamic] Playback timeline:', timeline);

            const playSegmentsSequentially = async () => {
                const sliced = await buildSegmentAudioUrls(detail.blobUrl, timeline);
                if (settled) return;
                for (const item of sliced) {
                    if (item?.url) segmentUrls.push(item.url);
                }

                for (let index = 0; index < sliced.length; index += 1) {
                    if (settled) return;
                    const { segment, url, start, end } = sliced[index];
                    console.log(`[Live2D+ Dynamic] Playing segment ${index + 1}/${sliced.length}:`, {
                        emotion: segment?.emotion || '',
                        action: segment?.action || null,
                        start,
                        end,
                        text: segment?.text || '',
                        hasAudio: !!url,
                    });

                    const durationMs = Math.max(350, Math.round(Math.max(0, (end || 0) - (start || 0)) * 1000));
                    captionControllerRef.current?.start({ text: segment?.text || '', durationMs });

                    let cueAllowed = true;
                    const applyCueForSegment = () => applyDynamicCue(model, liveSettings, segment, { shouldContinue: () => !settled && cueAllowed })
                        .then((cue) => {
                            if (settled || !cueAllowed || !cue) return cue;
                            if (!cue.motion && !cue.expression) {
                                console.warn('[Live2D+ Dynamic] No mapped motion/expression for segment:', {
                                    emotion: cue.emotion,
                                    action: cue.action,
                                    emotionMappingFound: cue.emotionMappingFound,
                                    actionMappingFound: cue.actionMappingFound,
                                    actionsEnabled: cue.actionsEnabled,
                                });
                            }
                            console.log(`[Live2D+ Dynamic] Cue result: ${describeDynamicCue(cue)}`, cue);
                            return cue;
                        })
                        .catch((error) => {
                            console.error('[Live2D+ Dynamic] Cue application failed:', error);
                            return null;
                        });

                    if (!url) {
                        await applyCueForSegment();
                        continue;
                    }

                    await new Promise((resolveSegment) => {
                        let segmentResolved = false;
                        const fallbackTimer = typeof window !== 'undefined'
                            ? window.setTimeout(() => {
                                console.warn(`[Live2D+ Dynamic] Segment ${index + 1} finish callback timed out; continuing to final reset.`);
                                resolveOnce();
                            }, Math.max(durationMs + 1500, 3000))
                            : 0;
                        const resolveOnce = () => {
                            if (segmentResolved) return;
                            segmentResolved = true;
                            cueAllowed = false;
                            if (fallbackTimer && typeof window !== 'undefined') window.clearTimeout(fallbackTimer);
                            resolveSegment();
                        };

                        try { model.stopSpeaking?.(); } catch { /* noop */ }
                        try {
                            const result = model.speak(url, {
                                volume: 0.7,
                                crossOrigin: 'anonymous',
                                onFinish: () => {
                                    console.log(`[Live2D+ Dynamic] Segment ${index + 1} finished.`);
                                    resolveOnce();
                                },
                                onError: (error) => {
                                    console.error(`[Live2D+ Dynamic] Segment ${index + 1} error:`, error);
                                    resolveOnce();
                                },
                            });

                            Promise.resolve(result)
                                .then((started) => {
                                    if (started === false) {
                                        console.warn(`[Live2D+ Dynamic] Segment ${index + 1} rejected by model.speak.`);
                                        resolveOnce();
                                        return;
                                    }
                                    applyCueForSegment();
                                })
                                .catch((error) => {
                                    console.error(`[Live2D+ Dynamic] Segment ${index + 1} start failed:`, error);
                                    resolveOnce();
                                });
                        } catch (error) {
                            console.error(`[Live2D+ Dynamic] Segment ${index + 1} threw:`, error);
                            resolveOnce();
                        }
                    });
                }

                if (!settled) finish();
            };

            playSegmentsSequentially().catch(fail);
        };

        window.addEventListener(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, handleDynamicTimestampsReady);
        return () => window.removeEventListener(TTS_DYNAMIC_TIMESTAMPS_READY_EVENT, handleDynamicTimestampsReady);
    }, [settings, resetModelStateAfterPlayback, stopActiveLipsync]);

    // Drag handlers
    const onPointerDown = useCallback((e) => {
        if (!settings.draggable) return;
        if (e.button !== undefined && e.button !== 0) return;

        dragStateRef.current?.cleanup?.();

        const pointerId = e.pointerId;
        const startClientX = e.clientX;
        const startClientY = e.clientY;
        const startX = pos.x;
        const startY = pos.y;

        const cleanup = () => {
            window.removeEventListener('pointermove', handleWindowPointerMove, true);
            window.removeEventListener('pointerup', handleWindowPointerUp, true);
            window.removeEventListener('pointercancel', handleWindowPointerUp, true);
        };

        const handleWindowPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) return;

            const deltaX = event.clientX - dragState.startClientX;
            const deltaY = event.clientY - dragState.startClientY;
            if (!dragState.dragging && Math.hypot(deltaX, deltaY) < DRAG_START_THRESHOLD_PX) return;

            dragState.dragging = true;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();

            const xOffset = (deltaX / Math.max(window.innerWidth, 1)) * 100;
            const yOffset = (deltaY / Math.max(window.innerHeight, 1)) * 100;
            const nextX = Math.min(100, Math.max(0, dragState.startX + xOffset));
            const nextY = Math.min(100, Math.max(0, dragState.startY + yOffset));
            dragState.currentX = nextX;
            dragState.currentY = nextY;
            setPos({ x: nextX, y: nextY });
        };

        const handleWindowPointerUp = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState || dragState.pointerId !== event.pointerId) return;

            cleanup();
            dragStateRef.current = null;

            if (!dragState.dragging) return;

            // Mark the drag end so the model's trailing tap/click is suppressed.
            justDraggedRef.current = Date.now();

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();

            // Commit the final position outside of a state updater. Calling the
            // parent's onChange from inside a setPos updater updates another
            // component during render, which triggers React error #185
            // (maximum update depth exceeded).
            onPositionCommit?.({
                positionX: Number(dragState.currentX.toFixed(2)),
                positionY: Number(dragState.currentY.toFixed(2)),
            });
        };

        dragStateRef.current = {
            pointerId,
            startClientX,
            startClientY,
            startX,
            startY,
            currentX: startX,
            currentY: startY,
            dragging: false,
            cleanup,
        };

        window.addEventListener('pointermove', handleWindowPointerMove, true);
        window.addEventListener('pointerup', handleWindowPointerUp, true);
        window.addEventListener('pointercancel', handleWindowPointerUp, true);
    }, [onPositionCommit, settings.draggable, pos.x, pos.y]);

    const wrapperStyle = {
        position: 'fixed',
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        width: `${settings.canvasWidth}px`,
        height: `${settings.canvasHeight}px`,
        transform: 'translate(-50%, -50%)',
        zIndex: settings.zIndex,
        pointerEvents: settings.draggable ? 'auto' : 'none',
        cursor: settings.draggable ? 'grab' : 'default',
        touchAction: settings.draggable ? 'none' : 'auto',
    };

    return (
        <div
            ref={rootRef}
            style={wrapperStyle}
            data-live2dplus-root="true"
            onPointerDown={onPointerDown}
        >
            <div
                ref={containerRef}
                style={{ display: 'block', width: '100%', height: '100%' }}
            />

            {status.state !== 'ready' && (
                <div style={{
                    position: 'absolute', bottom: 6, left: 6,
                    background: 'rgba(0,0,0,0.55)',
                    color: status.state === 'error' ? '#f87171' : '#c4b5fd',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: '0.75em',
                    pointerEvents: 'none',
                }}>
                    {status.message}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App({ settings, onChange, sttModel, onLoadSttModel }) {
    const s = normalizeSettings(settings);
    const sttModelState = sttModel || { state: 'idle', message: '' };

    const set = (patch) => onChange(patch);

    const setFilter = (id, enabled) => set({ filters: { ...s.filters, [id]: enabled } });

    const setFilterParam = (id, patch) => set({
        filterParams: {
            ...s.filterParams,
            [id]: { ...s.filterParams[id], ...patch },
        },
    });

    const setCaption = (patch) => set({ captions: { ...s.captions, ...patch } });

    const handleReload = () => set({ reloadKey: s.reloadKey + 1 });

    // Rendered canvas portal (only when enabled)
    const canvasPortal = s.enabled && typeof document !== 'undefined'
        ? createPortal(
            <Live2DCanvas settings={s} onPositionCommit={(pos) => set(pos)} />,
            document.body
        )
        : null;

    return (
        <>
            <style>{LIVE2D_PLUS_SETTINGS_STYLES}</style>
            {/* ── Main settings drawer ── */}
            <div className="inline-drawer live2d-plus-settings">
                <div className="inline-drawer-toggle inline-drawer-header">
                    <b>Live2D+</b>
                    <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down" />
                </div>
                <div className="inline-drawer-content">

                    {/* ── Global ── */}
                    <CheckboxRow label="Enable Live2D" checked={s.enabled} onChange={(v) => set({ enabled: v })} />
                    <CheckboxRow label="Follow Cursor" checked={s.followCursor} onChange={(v) => set({ followCursor: v })} />
                    <CheckboxRow label="Enable Dragging" checked={s.draggable} onChange={(v) => set({ draggable: v })} />
                    <CheckboxRow label="Enable Hit Testing" checked={s.enableHitTesting} onChange={(v) => set({ enableHitTesting: v })} />

                    {/* ── Speech-to-Text (lip-sync) ── */}
                    <SubDrawer title="Speech-to-Text (Vosk)">
                        <CheckboxRow
                            label="Enable STT timestamps"
                            checked={s.sttEnabled}
                            onChange={(v) => set({ sttEnabled: v })}
                        />
                        <small style={{ opacity: 0.55, display: 'block', marginBottom: '6px' }}>
                            Intercepts TTS audio, transcribes it with Vosk, and logs word-level
                            timestamps to the browser console.
                        </small>
                        <div>
                            <small style={{ display: 'block', marginBottom: '4px' }}>Vosk model URL</small>
                            <input
                                type="text"
                                className="text_pole"
                                placeholder={`${EXTENSION_WEB_PATH}/models/…tar.gz`}
                                value={s.voskModelUrl}
                                onChange={(e) => set({ voskModelUrl: e.target.value })}
                                style={{ width: '100%', marginBottom: '4px' }}
                            />
                            <small style={{ opacity: 0.5 }}>
                                Leave empty to use the bundled default model. Drop your own
                                <code> .tar.gz </code> models in the extension's <code>models/</code> folder.
                                The path must be one SillyTavern can serve (e.g.
                                <code>/scripts/extensions/third-party/&lt;folder&gt;/models/…tar.gz</code>);
                                local Android document paths are converted automatically when possible.
                            </small>
                        </div>

                        <div
                            className="menu_button full-width-action"
                            onClick={() => onLoadSttModel?.()}
                            style={{
                                marginTop: '8px',
                                opacity: sttModelState.state === 'loading' ? 0.6 : 1,
                                pointerEvents: sttModelState.state === 'loading' ? 'none' : 'auto',
                            }}
                        >
                            <i
                                className={
                                    sttModelState.state === 'loading'
                                        ? 'fa-solid fa-spinner fa-spin'
                                        : 'fa-solid fa-download'
                                }
                                style={{ marginRight: '6px' }}
                            />
                            {sttModelState.state === 'ready' ? 'Reload Vosk model' : 'Load Vosk model'}
                        </div>
                        {sttModelState.message && (
                            <small
                                style={{
                                    display: 'block',
                                    marginTop: '4px',
                                    color: sttModelState.state === 'error' ? '#f87171'
                                        : sttModelState.state === 'ready' ? '#4ade80' : 'inherit',
                                    opacity: sttModelState.state === 'error' || sttModelState.state === 'ready' ? 1 : 0.6,
                                    wordBreak: 'break-all',
                                }}
                            >
                                {sttModelState.message}
                            </small>
                        )}
                        <small style={{ opacity: 0.55, display: 'block', marginTop: '6px' }}>
                            You must load a model before TTS audio can be transcribed.
                        </small>
                    </SubDrawer>

                    <DynamicSettingsSection
                        settings={s}
                        onChange={set}
                        readRuntimeModelInfo={readRuntimeModelInfo}
                        modelInfoEventName={LIVE2D_MODEL_INFO_EVENT}
                    />

                    <TapInteractionsSection
                        settings={s}
                        onChange={set}
                        readRuntimeModelInfo={readRuntimeModelInfo}
                        modelInfoEventName={LIVE2D_MODEL_INFO_EVENT}
                    />

                    {/* -- Captions -- */}
                    <SubDrawer title="Captions">
                        <CheckboxRow
                            label="Enable captions"
                            checked={s.captions.enabled}
                            onChange={(v) => setCaption({ enabled: v })}
                        />
                        <small style={{ opacity: 0.55, display: 'block', marginBottom: '6px' }}>
                            Captions render over the Live2D overlay while routed TTS segments play.
                        </small>
                        {!s.routeTtsToLive2D && (
                            <small style={{ opacity: 0.65, display: 'block', marginBottom: '6px', color: '#fbbf24' }}>
                                Turn on Live2D TTS routing in Dynamic Analysis to show captions during playback.
                            </small>
                        )}

                        <label className="field">
                            <span>Caption Style</span>
                            <select
                                className="text_pole"
                                value={s.captions.style}
                                onChange={(event) => setCaption({ style: event.target.value })}
                            >
                                {CAPTION_STYLE_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </label>

                        <ColorInput label="Base Color" value={s.captions.textColor} onChange={(v) => setCaption({ textColor: v })} />
                        <ColorInput label="Fill Color" value={s.captions.fillColor} onChange={(v) => setCaption({ fillColor: v })} />
                        <ColorInput label="Shadow Color" value={s.captions.shadowColor} onChange={(v) => setCaption({ shadowColor: v })} />

                        <Slider label="Font Size" value={s.captions.fontSize} min={18} max={96} step={1}
                            onChange={(v) => setCaption({ fontSize: v })} displayValue={`${Math.round(s.captions.fontSize)}px`} />
                        <Slider label="Font Weight" value={s.captions.fontWeight} min={400} max={900} step={100}
                            onChange={(v) => setCaption({ fontWeight: v })} displayValue={Math.round(s.captions.fontWeight)} />
                        <Slider label="Letter Spacing" value={s.captions.letterSpacing} min={-0.04} max={0.24} step={0.01}
                            onChange={(v) => setCaption({ letterSpacing: v })} displayValue={`${formatNumber(s.captions.letterSpacing, 2)}em`} />
                        <Slider label="Line Height" value={s.captions.lineHeight} min={0.8} max={1.8} step={0.02}
                            onChange={(v) => setCaption({ lineHeight: v })} displayValue={formatNumber(s.captions.lineHeight, 2)} />
                        <Slider label="Bottom Offset" value={s.captions.bottomOffset} min={0} max={120} step={1}
                            onChange={(v) => setCaption({ bottomOffset: v })} displayValue={`${Math.round(s.captions.bottomOffset)}px`} />
                        <Slider label="Max Width" value={s.captions.maxWidth} min={30} max={100} step={1}
                            onChange={(v) => setCaption({ maxWidth: v })} displayValue={`${Math.round(s.captions.maxWidth)}%`} />

                        <label className="field">
                            <span>Custom CSS</span>
                            <textarea
                                className="text_pole"
                                rows={5}
                                value={s.captions.customCss}
                                onChange={(event) => setCaption({ customCss: event.target.value })}
                                placeholder={'transform: translateY(-4px);\nfilter: drop-shadow(0 0 14px rgba(255, 155, 113, 0.35));'}
                                style={{ width: '100%', resize: 'vertical' }}
                            />
                        </label>
                    </SubDrawer>

                    {/* ── Model ── */}
                    <SubDrawer title="Model">
                        <div style={{ marginBottom: '6px' }}>
                            <small style={{ display: 'block', marginBottom: '4px' }}>Source</small>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {[
                                    { value: MODEL_SOURCES.DEFAULT, label: 'Default' },
                                    { value: MODEL_SOURCES.URL, label: 'URL' },
                                    { value: MODEL_SOURCES.LOCAL, label: 'Local' },
                                ].map(({ value, label }) => (
                                    <div
                                        key={value}
                                        className="menu_button"
                                        onClick={() => set({ modelSource: value })}
                                        style={{
                                            flex: 1,
                                            textAlign: 'center',
                                            fontWeight: s.modelSource === value ? 'bold' : 'normal',
                                            opacity: s.modelSource === value ? 1 : 0.6,
                                        }}
                                    >
                                        {label}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {s.modelSource === MODEL_SOURCES.DEFAULT && (
                            <small style={{ opacity: 0.55, display: 'block' }}>
                                Using Shizuku demo model (CDN).
                            </small>
                        )}

                        {s.modelSource === MODEL_SOURCES.URL && (
                            <div>
                                <small style={{ display: 'block', marginBottom: '4px' }}>Model URL</small>
                                <input
                                    type="text"
                                    className="text_pole"
                                    placeholder="https://..."
                                    value={s.customModelUrl}
                                    onChange={(e) => set({ customModelUrl: e.target.value })}
                                    style={{ width: '100%', marginBottom: '4px' }}
                                />
                            </div>
                        )}

                        {s.modelSource === MODEL_SOURCES.LOCAL && (
                            <div>
                                <small style={{ display: 'block', marginBottom: '4px' }}>Local path (served by ST)</small>
                                <input
                                    type="text"
                                    className="text_pole"
                                    placeholder="/user/images/live2d/Model/model3.json"
                                    value={s.localModelPath}
                                    onChange={(e) => set({ localModelPath: e.target.value })}
                                    style={{ width: '100%', marginBottom: '4px' }}
                                />
                                <small style={{ opacity: 0.5 }}>Path relative to the SillyTavern server root.</small>
                            </div>
                        )}

                        <div
                            className="menu_button"
                            onClick={handleReload}
                            style={{ marginTop: '8px', width: '100%', textAlign: 'center' }}
                        >
                            <i className="fa-solid fa-rotate-right" style={{ marginRight: '4px' }} />
                            Reload Model
                        </div>
                    </SubDrawer>

                    {/* ── Rendering ── */}
                    <SubDrawer title="Rendering">
                        <Slider label="Canvas Width" value={s.canvasWidth} min={200} max={2000} step={50}
                            onChange={(v) => set({ canvasWidth: v })} displayValue={`${s.canvasWidth}px`}
                            showInput inputMax={3000} />
                        <Slider label="Canvas Height" value={s.canvasHeight} min={200} max={2000} step={50}
                            onChange={(v) => set({ canvasHeight: v })} displayValue={`${s.canvasHeight}px`}
                            showInput inputMax={3000} />
                        <Slider label="Scale" value={s.scale} min={0.1} max={5} step={0.05}
                            onChange={(v) => set({ scale: v })} displayValue={s.scale.toFixed(2)}
                            showInput inputMax={10} />
                        <Slider label="Screen Position X" value={s.positionX} min={0} max={100} step={1}
                            onChange={(v) => set({ positionX: v })} displayValue={`${s.positionX}%`}
                            showInput inputMax={100} />
                        <Slider label="Screen Position Y" value={s.positionY} min={0} max={100} step={1}
                            onChange={(v) => set({ positionY: v })} displayValue={`${s.positionY}%`}
                            showInput inputMax={100} />
                        <Slider label="Model Anchor X" value={s.modelPositionX} min={0} max={100} step={1}
                            onChange={(v) => set({ modelPositionX: v })} displayValue={`${s.modelPositionX}%`}
                            showInput inputMax={100} />
                        <Slider label="Model Anchor Y" value={s.modelPositionY} min={0} max={100} step={1}
                            onChange={(v) => set({ modelPositionY: v })} displayValue={`${s.modelPositionY}%`}
                            showInput inputMax={100} />
                        <Slider label="Opacity" value={s.opacity} min={0} max={1} step={0.05}
                            onChange={(v) => set({ opacity: v })} displayValue={s.opacity.toFixed(2)}
                            showInput inputMax={1} />
                        <Slider label="Z-Index" value={s.zIndex} min={1} max={9999} step={1}
                            onChange={(v) => set({ zIndex: v })} showInput inputMax={9999} />
                    </SubDrawer>

                    {/* ── Filters ── */}
                    <SubDrawer title="Filters">

                        <CheckboxRow label="Outline" checked={s.filters.outline} onChange={(v) => setFilter('outline', v)} />
                        {s.filters.outline && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Thickness" value={s.filterParams.outline.thickness} min={0} max={20} step={0.5}
                                    onChange={(v) => setFilterParam('outline', { thickness: v })}
                                    displayValue={s.filterParams.outline.thickness} />
                                <ColorInput label="Color" value={s.filterParams.outline.color}
                                    onChange={(v) => setFilterParam('outline', { color: v })} />
                            </div>
                        )}

                        <CheckboxRow label="Pixelate" checked={s.filters.pixelate} onChange={(v) => setFilter('pixelate', v)} />
                        {s.filters.pixelate && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Size" value={s.filterParams.pixelate.size} min={1} max={50} step={1}
                                    onChange={(v) => setFilterParam('pixelate', { size: v })}
                                    displayValue={`${s.filterParams.pixelate.size}px`} />
                            </div>
                        )}

                        <CheckboxRow label="CRT" checked={s.filters.crt} onChange={(v) => setFilter('crt', v)} />
                        {s.filters.crt && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Curvature" value={s.filterParams.crt.curvature} min={0} max={10} step={0.1}
                                    onChange={(v) => setFilterParam('crt', { curvature: v })}
                                    displayValue={s.filterParams.crt.curvature.toFixed(1)} />
                                <Slider label="Line Width" value={s.filterParams.crt.lineWidth} min={0} max={10} step={0.1}
                                    onChange={(v) => setFilterParam('crt', { lineWidth: v })}
                                    displayValue={s.filterParams.crt.lineWidth.toFixed(1)} />
                                <Slider label="Line Contrast" value={s.filterParams.crt.lineContrast} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { lineContrast: v })}
                                    displayValue={s.filterParams.crt.lineContrast.toFixed(2)} />
                                <Slider label="Vignetting" value={s.filterParams.crt.vignetting} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { vignetting: v })}
                                    displayValue={s.filterParams.crt.vignetting.toFixed(2)} />
                                <Slider label="Vignette Alpha" value={s.filterParams.crt.vignettingAlpha} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { vignettingAlpha: v })}
                                    displayValue={s.filterParams.crt.vignettingAlpha.toFixed(2)} />
                                <Slider label="Noise" value={s.filterParams.crt.noise} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('crt', { noise: v })}
                                    displayValue={s.filterParams.crt.noise.toFixed(2)} />
                            </div>
                        )}

                        <CheckboxRow label="Noise" checked={s.filters.noise} onChange={(v) => setFilter('noise', v)} />
                        {s.filters.noise && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Intensity" value={s.filterParams.noise.noise} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('noise', { noise: v })}
                                    displayValue={s.filterParams.noise.noise.toFixed(2)} />
                            </div>
                        )}

                        <CheckboxRow label="Alpha" checked={s.filters.alpha} onChange={(v) => setFilter('alpha', v)} />
                        {s.filters.alpha && (
                            <div style={{ paddingLeft: '16px', marginBottom: '8px' }}>
                                <Slider label="Alpha" value={s.filterParams.alpha.alpha} min={0} max={1} step={0.01}
                                    onChange={(v) => setFilterParam('alpha', { alpha: v })}
                                    displayValue={s.filterParams.alpha.alpha.toFixed(2)} />
                            </div>
                        )}

                    </SubDrawer>

                    {/* ── Motion & Expression Test ── */}
                    <SubDrawer title="Motion & Expression Test">
                        <MotionTestSection
                            defaultStateResetDelayMs={DEFAULT_STATE_RESET_DELAY_MS}
                            resetDynamicState={resetDynamicState}
                            stopModelMotionsOnly={stopModelMotionsOnly}
                            readMotionDurationMs={readMotionDurationMs}
                            getMotionManager={getMotionManager}
                        />
                    </SubDrawer>

                </div>
            </div>

            {/* Live2D canvas portal */}
            {canvasPortal}
        </>
    );
}
