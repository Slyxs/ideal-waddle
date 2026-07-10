const ANALYSIS_TEMPERATURE = 0.8;
const ANALYSIS_MAX_TOKENS = 1800;

export const DEFAULT_ANALYSIS_MODEL = 'gpt-4o-mini';

export const DEFAULT_EMOTION_LABELS = Object.freeze([
    'Admiration',
    'Amusement',
    'Anger',
    'Annoyance',
    'Approval',
    'Caring',
    'Confusion',
    'Curiosity',
    'Desire',
    'Disappointment',
    'Disapproval',
    'Disgust',
    'Embarrassment',
    'Excitement',
    'Fear',
    'Gratitude',
    'Joy',
    'Love',
    'Nervousness',
    'Neutral',
    'Optimism',
    'Pride',
    'Realization',
    'Relief',
    'Remorse',
    'Sadness',
    'Surprise',
]);

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeUrl(baseUrl) {
    let url = normalizeText(baseUrl).replace(/\/+$/, '');
    if (url.endsWith('/chat/completions')) url = url.slice(0, -'/chat/completions'.length);
    if (url.endsWith('/models')) url = url.slice(0, -'/models'.length);
    return url;
}

function apiUrl(baseUrl, path) {
    const normalized = normalizeUrl(baseUrl);
    if (!normalized) throw new Error('Add an OpenAI-compatible analysis URL first.');
    return `${normalized}${path}`;
}

function authHeaders(apiKey) {
    const key = normalizeText(apiKey);
    return key ? { Authorization: `Bearer ${key}` } : {};
}

function readNeutralEmotion(emotions = []) {
    return emotions.find((emotion) => String(emotion).toLowerCase() === 'neutral') || emotions[0] || 'Neutral';
}

export function createNeutralDynamicSegments(text, settings = {}) {
    const emotions = Array.isArray(settings.emotionLabels) ? settings.emotionLabels : DEFAULT_EMOTION_LABELS;
    return [{ emotion: readNeutralEmotion(emotions), action: null, text: typeof text === 'string' ? text : '' }];
}

function readDynamicActionDescriptions(settings = {}) {
    const actions = Array.isArray(settings.actionMappings) ? settings.actionMappings : [];
    return actions
        .map((action) => normalizeText(action?.description))
        .filter(Boolean);
}

function buildAnalysisPrompt({ text, emotions, actions }) {
    const actionsText = actions.length > 0
        ? actions.map((action) => `- ${action}`).join('\n')
        : '- null';

    return `You are a strict JSON text segment analyzer for a Live2D character.

Return JSON only. The response must be an array of objects with exactly these keys:
emotion, action, text.

Rules:
- Preserve every character from the input text exactly.
- The concatenation of every returned text field must equal the input text exactly.
- Split only when the emotion meaningfully changes or a configured action occurs.
- Merge adjacent segments when they share the same emotion and action.
- Use one emotion from the configured emotion list.
- Use one action from the configured action list, or null.
- If no action applies, action must be null.

Configured emotions:
${emotions.map((emotion) => `- ${emotion}`).join('\n')}

Configured actions:
${actionsText}

Input text as a JSON string:
${JSON.stringify(text)}`;
}

function parseJsonResponseText(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) throw new Error('Analysis returned an empty response.');

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const source = fenced ? fenced[1].trim() : raw;

    try {
        return JSON.parse(source);
    } catch {
        const start = source.indexOf('[');
        const end = source.lastIndexOf(']');
        if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
        const objectStart = source.indexOf('{');
        const objectEnd = source.lastIndexOf('}');
        if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(source.slice(objectStart, objectEnd + 1));
        throw new Error('Analysis did not return valid JSON.');
    }
}

function normalizeAnalysisSegments(raw, originalText, emotions = [], actions = []) {
    const rawSegments = Array.isArray(raw) ? raw : Array.isArray(raw?.segments) ? raw.segments : [];
    if (!rawSegments.length) return createNeutralDynamicSegments(originalText, { emotionLabels: emotions });

    const emotionKeys = new Map(emotions.map((emotion) => [String(emotion).toLowerCase(), emotion]));
    const actionKeys = new Map(actions.map((action) => [String(action).toLowerCase(), action]));
    const segments = rawSegments.map((segment) => {
        const rawEmotion = normalizeText(segment?.emotion);
        const emotion = emotionKeys.get(rawEmotion.toLowerCase()) || rawEmotion || readNeutralEmotion(emotions);
        const rawAction = normalizeText(segment?.action);
        const action = rawAction && rawAction.toLowerCase() !== 'null'
            ? actionKeys.get(rawAction.toLowerCase()) || rawAction
            : null;
        return {
            emotion,
            action,
            text: typeof segment?.text === 'string' ? segment.text : '',
        };
    });

    const reconstructed = segments.map((segment) => segment.text).join('');
    if (reconstructed !== originalText) {
        console.warn('[Live2D Dynamic] Analysis text did not reconstruct exactly; using neutral fallback.', {
            originalText,
            reconstructed,
            segments,
        });
        return createNeutralDynamicSegments(originalText, { emotionLabels: emotions });
    }

    return segments.reduce((merged, segment) => {
        if (!segment.text) return merged;
        const previous = merged[merged.length - 1];
        if (previous && previous.emotion === segment.emotion && previous.action === segment.action) {
            previous.text += segment.text;
            return merged;
        }
        merged.push({ ...segment });
        return merged;
    }, []);
}

function readCompletionText(payload) {
    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const content = choice?.message?.content ?? choice?.text ?? '';
    if (Array.isArray(content)) {
        return content.map((part) => part?.text || part?.content || '').join('');
    }
    return typeof content === 'string' ? content : '';
}

export async function fetchOpenAiModels({ baseUrl, apiKey } = {}) {
    const response = await fetch(apiUrl(baseUrl, '/models'), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            ...authHeaders(apiKey),
        },
    });
    if (!response.ok) throw new Error(`Failed to fetch models (${response.status}).`);
    const payload = await response.json();
    const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return source
        .map((model) => {
            const id = normalizeText(model?.id || model?.name || model);
            return id ? { id, name: normalizeText(model?.name) || id } : null;
        })
        .filter(Boolean);
}

export async function analyzeDynamicText(text, settings = {}) {
    const sourceText = typeof text === 'string' ? text : '';
    const emotions = Array.isArray(settings.emotionLabels) && settings.emotionLabels.length
        ? settings.emotionLabels
        : DEFAULT_EMOTION_LABELS;
    const actions = readDynamicActionDescriptions(settings);
    const model = normalizeText(settings.analysisModel) || DEFAULT_ANALYSIS_MODEL;
    const prompt = buildAnalysisPrompt({ text: sourceText, emotions, actions });

    if (!sourceText.trim()) {
        return { segments: createNeutralDynamicSegments(sourceText, { emotionLabels: emotions }), skipped: true };
    }

    if (!normalizeText(settings.analysisBaseUrl)) {
        console.warn('[Live2D Dynamic] No analysis URL configured; using neutral fallback.');
        return { segments: createNeutralDynamicSegments(sourceText, { emotionLabels: emotions }), skipped: true };
    }

    console.log('[Live2D Dynamic] Analysis request:', {
        baseUrl: normalizeUrl(settings.analysisBaseUrl),
        model,
        temperature: ANALYSIS_TEMPERATURE,
        text: sourceText,
        emotions,
        actions,
    });

    try {
        const response = await fetch(apiUrl(settings.analysisBaseUrl, '/chat/completions'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...authHeaders(settings.analysisApiKey),
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: ANALYSIS_TEMPERATURE,
                max_tokens: ANALYSIS_MAX_TOKENS,
                stream: false,
            }),
        });
        if (!response.ok) throw new Error(`Analysis request failed (${response.status}).`);
        const payload = await response.json();
        const rawResponseText = readCompletionText(payload);
        const parsed = parseJsonResponseText(rawResponseText);
        const segments = normalizeAnalysisSegments(parsed, sourceText, emotions, actions);
        console.log('[Live2D Dynamic] Analysis response:', { model, rawResponseText, parsed, segments });
        return {
            model,
            temperature: ANALYSIS_TEMPERATURE,
            source: { type: 'openai-compatible', baseUrl: normalizeUrl(settings.analysisBaseUrl) },
            rawResponseText,
            parsed,
            segments,
        };
    } catch (error) {
        console.warn('[Live2D Dynamic] Analysis failed; using neutral fallback:', error?.message || error);
        return {
            model,
            temperature: ANALYSIS_TEMPERATURE,
            source: { type: 'openai-compatible', baseUrl: normalizeUrl(settings.analysisBaseUrl) },
            error: error?.message || 'analysis_failed',
            segments: createNeutralDynamicSegments(sourceText, { emotionLabels: emotions }),
        };
    }
}