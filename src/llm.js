const DEBUG = false; // Set to false to disable debug logging
// LLM factory — OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

// Generous enough for a full LeetCode-style answer (approach + code + complexity)
// without truncating mid-response; still a hard cap since some SDKs require one.
const DEFAULT_MAX_TOKENS = 8192;

// Safety net so a stalled/hung provider request can't wedge state.busy forever.
const REQUEST_TIMEOUT_MS = 90000;

// Providers that speak the OpenAI chat-completions API but aren't OpenAI itself —
// just a different base URL. NVIDIA NIM and OpenRouter both fall into this bucket.
const PROVIDER_BASE_URLS = {
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
};

// OpenRouter asks OpenAI-compatible clients to identify the calling app via these
// headers (used for their public leaderboards, not required for the API to work).
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/daydroidmuchiri/cue', 'X-Title': 'cue' };

// OpenRouter's own router: auto-picks among whatever free models are actually
// live right now. Used as a client-side retry target below — NOT sent as part
// of a multi-model `models` request field, because OpenRouter validates every
// ID in that array up front and 400s the *entire* request if even one entry
// has rotated out of the catalog, which defeats the purpose of a fallback.
const OPENROUTER_FREE_MODEL = 'openrouter/free';

function resolveBaseURL(provider) {
  return PROVIDER_BASE_URLS[provider];
}

// True when the chosen model itself is the problem — removed from the catalog
// (400/404) or its upstream provider is rate-limited/down (429), which is
// common on OpenRouter's free tier since individual free models share tight
// per-minute limits across all users. Worth a one-time retry against the free
// router, which picks a different model. Not true for timeouts/aborts (no HTTP
// status) or auth errors (401/403), which should surface as-is.
function isRetriableOpenRouterError(err) {
  return !!err && (err.status === 400 || err.status === 404 || err.status === 429);
}

// Gates the fallback retry. Critically: `emittedAny` must be false -- if the
// primary model already streamed some tokens before failing, retrying would
// concatenate a second model's full response onto the first one's partial
// output in the same UI bubble, with no separator and no indication a retry
// happened. Safer to surface the error than risk garbled output.
function shouldRetryWithFreeRouter({ provider, model, emittedAny, err }) {
  return provider === 'openrouter' && model !== OPENROUTER_FREE_MODEL && !emittedAny && isRetriableOpenRouterError(err);
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// Races `promise` against a timeout. On timeout, aborts `controller` (so SDKs
// that honor AbortSignal actually cancel the in-flight request) and rejects.
function withTimeout(promise, ms, controller) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error('Request timed out after ' + Math.round(ms / 1000) + 's'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, baseURL, extraHeaders, signal }) {
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI called', { model, baseURL, hasImage: !!imageDataUrl, maxTokens });
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL, defaultHeaders: extraHeaders });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  if (DEBUG) console.log('[DEBUG LLM] streamOpenAI sending request to OpenAI SDK with messages count:', messages.length);
  try {
    const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens }, { signal });
    let full = '';
    for await (const part of stream) {
      const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
      if (d) { full += d; onToken(d); }
    }
    if (DEBUG) console.log('[DEBUG LLM] streamOpenAI finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamOpenAI error:', err);
    throw err;
  }
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal }) {
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic called', { model, hasImage: !!imageDataUrl, maxTokens });
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  if (DEBUG) console.log('[DEBUG LLM] streamAnthropic sending request to Anthropic SDK with messages count:', messages.length);
  try {
    const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true }, { signal });
    let full = '';
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    }
    if (DEBUG) console.log('[DEBUG LLM] streamAnthropic finished successfully, total length:', full.length);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamAnthropic error:', err);
    throw err;
  }
}

// The @google/genai SDK has no AbortSignal support on generateContentStream, so
// `signal` here only guards our own wait (via withTimeout) — the underlying HTTP
// request may keep running server-side after we've given up on it.
async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  if (DEBUG) console.log('[DEBUG LLM] streamGemini called', { model, hasImage: !!imageDataUrl, maxTokens });
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  if (DEBUG) console.log('[DEBUG LLM] streamGemini sending request to Google SDK with contents count:', contents.length);
  try {
    const stream = await ai.models.generateContentStream({
      model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
    });
    let full = '';
    let lastFinishReason = 'UNKNOWN';
    for await (const chunk of stream) {
      const t = chunk && chunk.text;
      if (t) { full += t; onToken(t); }
      if (chunk && chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason) {
        lastFinishReason = chunk.candidates[0].finishReason;
      }
    }
    if (DEBUG) console.log('[DEBUG LLM] streamGemini finished successfully, total length:', full.length, 'finishReason:', lastFinishReason);
    return full;
  } catch (err) {
    if (DEBUG) console.error('[DEBUG LLM] streamGemini error:', err);
    throw err;
  }
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  const model = (settings.models[provider] || {})[tier];
  const maxTokens = DEFAULT_MAX_TOKENS;

  if (DEBUG) console.log('[DEBUG LLM] createLLM initialized:', { provider, model, isKeyPresent: !!apiKey, ready: !!apiKey && !!model });

  return {
    provider, model, apiKey,
    ready: !!apiKey && !!model,
    async stream(params) {
      if (DEBUG) console.log('[DEBUG LLM] stream() invoked for provider:', provider);
      const controller = new AbortController();
      const args = { apiKey, model, maxTokens, signal: controller.signal, ...params };
      const run = async () => {
        if (provider === 'openai' || provider === 'nvidia' || provider === 'openrouter') {
          let emittedAny = false;
          const openAIArgs = {
            ...args,
            onToken: (t) => { emittedAny = true; args.onToken(t); },
            baseURL: resolveBaseURL(provider),
            extraHeaders: provider === 'openrouter' ? OPENROUTER_HEADERS : undefined
          };
          try {
            return await streamOpenAI(openAIArgs);
          } catch (err) {
            // The chosen model is unusable right now (rotated out of the catalog,
            // or its free-tier provider is rate-limited) — retry once against
            // OpenRouter's own free-model router instead of failing outright.
            // Only if nothing has streamed yet -- see shouldRetryWithFreeRouter.
            if (shouldRetryWithFreeRouter({ provider, model, emittedAny, err })) {
              return await streamOpenAI({ ...openAIArgs, model: OPENROUTER_FREE_MODEL });
            }
            throw err;
          }
        }
        if (provider === 'anthropic') return streamAnthropic(args);
        if (provider === 'gemini') return streamGemini(args);
        return Promise.reject(new Error('unknown provider: ' + provider));
      };
      return withTimeout(run(), REQUEST_TIMEOUT_MS, controller);
    }
  };
}

module.exports = { createLLM, withTimeout, resolveBaseURL, isRetriableOpenRouterError, shouldRetryWithFreeRouter, OPENROUTER_FREE_MODEL, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS };
