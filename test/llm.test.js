const assert = require('node:assert/strict');
const test = require('node:test');
const { withTimeout, createLLM, resolveBaseURL, isRetriableOpenRouterError, shouldRetryWithFreeRouter, OPENROUTER_FREE_MODEL, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } = require('../src/llm');

test('withTimeout resolves normally when the promise settles first', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 50, new AbortController());
  assert.equal(result, 'ok');
});

test('withTimeout rejects once the timeout elapses', async () => {
  const neverResolves = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(neverResolves, 20, new AbortController()),
    /timed out/i
  );
});

test('withTimeout aborts the given controller on timeout', async () => {
  const controller = new AbortController();
  const neverResolves = new Promise(() => {});
  await assert.rejects(() => withTimeout(neverResolves, 20, controller));
  assert.equal(controller.signal.aborted, true);
});

test('withTimeout propagates the original rejection reason when the promise fails first', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('boom')), 50, new AbortController()),
    /boom/
  );
});

test('createLLM.ready is false when no API key is set for the provider', () => {
  const llm = createLLM({ provider: 'openai', apiKeys: {}, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false });
  assert.equal(llm.ready, false);
});

test('createLLM.ready is false when no model is configured for the tier', () => {
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: {} }, smart: false });
  assert.equal(llm.ready, false);
});

test('createLLM.ready is true when both a key and a model are present', () => {
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }, smart: false });
  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'gpt-4o-mini');
});

test('createLLM picks the smart-tier model when settings.smart is true', () => {
  const llm = createLLM({ provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }, smart: true });
  assert.equal(llm.model, 'gpt-4o');
});

test('createLLM.stream rejects for an unknown provider without hanging', async () => {
  const llm = createLLM({ provider: 'not-a-provider', apiKeys: {}, models: {}, smart: false });
  await assert.rejects(() => llm.stream({ system: '', turns: [], onToken: () => {} }), /unknown provider/i);
});

test('createLLM.ready works for the openrouter provider like any other', () => {
  const llm = createLLM({ provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'meta-llama/llama-3.2-11b-vision-instruct:free' } }, smart: false });
  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'meta-llama/llama-3.2-11b-vision-instruct:free');
});

test('resolveBaseURL points nvidia and openrouter at their OpenAI-compatible endpoints', () => {
  assert.equal(resolveBaseURL('nvidia'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(resolveBaseURL('openrouter'), 'https://openrouter.ai/api/v1');
});

// GitHub Models was fully retired on 2026-07-30; both endpoints cue used now
// return 410 Gone. Routing to it can only ever produce a confusing hard error.
test('the retired github provider is no longer routable', () => {
  assert.equal(resolveBaseURL('github'), undefined);
  const llm = createLLM({ provider: 'github', apiKeys: { github: 'github_pat_x' }, models: { github: { fast: 'openai/gpt-4o-mini' } }, smart: false });
  return assert.rejects(() => llm.stream({ system: '', turns: [], onToken: () => {} }), /unknown provider/i);
});

test('resolveBaseURL is undefined for providers that use their own SDK/endpoint', () => {
  assert.equal(resolveBaseURL('openai'), undefined);
  assert.equal(resolveBaseURL('anthropic'), undefined);
  assert.equal(resolveBaseURL('gemini'), undefined);
});

test('isRetriableOpenRouterError is true for OpenRouter\'s "no endpoints found" 404', () => {
  assert.equal(isRetriableOpenRouterError({ status: 404, message: 'No endpoints found for x/y:free' }), true);
});

test('isRetriableOpenRouterError is true for OpenRouter\'s "not a valid model ID" 400', () => {
  assert.equal(isRetriableOpenRouterError({ status: 400, message: 'x/y:free is not a valid model ID' }), true);
});

test('isRetriableOpenRouterError is true for a 429 rate-limited provider', () => {
  assert.equal(isRetriableOpenRouterError({ status: 429, message: 'Provider returned error' }), true);
});

test('isRetriableOpenRouterError is false for auth errors', () => {
  assert.equal(isRetriableOpenRouterError({ status: 401, message: 'Invalid API key' }), false);
});

test('isRetriableOpenRouterError is false for timeouts/aborts (no HTTP status)', () => {
  assert.equal(isRetriableOpenRouterError(new Error('Request timed out after 90s')), false);
});

test('isRetriableOpenRouterError is false for no error', () => {
  assert.equal(isRetriableOpenRouterError(null), false);
});

test('shouldRetryWithFreeRouter is true for a fresh, retriable failure on openrouter', () => {
  const ok = shouldRetryWithFreeRouter({ provider: 'openrouter', model: 'some/model:free', emittedAny: false, err: { status: 404 } });
  assert.equal(ok, true);
});

test('CRITICAL: shouldRetryWithFreeRouter is false once any token has already streamed', () => {
  // Retrying after partial output would concatenate a second model's full
  // response onto the first model's partial one in the same UI bubble, with
  // no separator and no indication a retry happened -- garbled output.
  const ok = shouldRetryWithFreeRouter({ provider: 'openrouter', model: 'some/model:free', emittedAny: true, err: { status: 429 } });
  assert.equal(ok, false);
});

test('shouldRetryWithFreeRouter is false for other providers even on a retriable-shaped error', () => {
  const ok = shouldRetryWithFreeRouter({ provider: 'nvidia', model: 'some/model', emittedAny: false, err: { status: 404 } });
  assert.equal(ok, false);
});

test('shouldRetryWithFreeRouter is false when already on the free router (avoid retrying into itself)', () => {
  const ok = shouldRetryWithFreeRouter({ provider: 'openrouter', model: OPENROUTER_FREE_MODEL, emittedAny: false, err: { status: 404 } });
  assert.equal(ok, false);
});

test('shouldRetryWithFreeRouter is false for a non-retriable error even with no tokens emitted', () => {
  const ok = shouldRetryWithFreeRouter({ provider: 'openrouter', model: 'some/model:free', emittedAny: false, err: { status: 401 } });
  assert.equal(ok, false);
});

test('OPENROUTER_FREE_MODEL is the stable router id used as a retry target', () => {
  assert.equal(OPENROUTER_FREE_MODEL, 'openrouter/free');
});

test('DEFAULT_MAX_TOKENS is generous enough for a full solution + explanation', () => {
  assert.ok(DEFAULT_MAX_TOKENS >= 8000);
});

test('REQUEST_TIMEOUT_MS is a sane positive duration', () => {
  assert.ok(REQUEST_TIMEOUT_MS > 10000);
});

// ---- provider streaming contract tests -------------------------------
// The real SDKs (openai / @anthropic-ai/sdk / @google/genai) are injected via
// createLLM's second argument instead of required directly, so these never
// touch the network -- each fake mimics just enough of the real client's
// shape (constructor + streaming method returning an async iterable) to
// exercise message-shape construction and token accumulation.

function makeFakeOpenAI(chunks) {
  const instances = [];
  class FakeOpenAIClient {
    constructor(opts) {
      this.opts = opts;
      instances.push(this);
      this.chat = { completions: { create: async (params, callOpts) => {
        this.lastParams = params;
        this.lastCallOpts = callOpts;
        return (async function* () { for (const c of chunks) yield c; })();
      } } };
    }
  }
  FakeOpenAIClient.instances = instances;
  return FakeOpenAIClient;
}

function makeFakeAnthropic(events) {
  const instances = [];
  class FakeAnthropicClient {
    constructor(opts) {
      this.opts = opts;
      instances.push(this);
      this.messages = { create: async (params) => {
        this.lastParams = params;
        return (async function* () { for (const e of events) yield e; })();
      } };
    }
  }
  FakeAnthropicClient.instances = instances;
  return FakeAnthropicClient;
}

function makeFakeGemini(chunks) {
  const instances = [];
  class FakeGoogleGenAIClient {
    constructor(opts) {
      this.opts = opts;
      instances.push(this);
      this.models = { generateContentStream: async (params) => {
        this.lastParams = params;
        return (async function* () { for (const c of chunks) yield c; })();
      } };
    }
  }
  FakeGoogleGenAIClient.instances = instances;
  return FakeGoogleGenAIClient;
}

test('streamOpenAI: accumulates streamed tokens and calls onToken for each', async () => {
  const OpenAIClient = makeFakeOpenAI([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: {} }] } // no content -- must not append 'undefined'
  ]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  let tokens = '';
  const full = await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: (t) => { tokens += t; } });
  assert.equal(full, 'Hello');
  assert.equal(tokens, 'Hello');
});

test('streamOpenAI: attaches the image to only the last user turn, as a content array', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({
    system: 'sys',
    turns: [{ role: 'user', text: 'hi' }],
    imageDataUrl: 'data:image/png;base64,AAAA',
    onToken: () => {}
  });
  const { messages } = OpenAIClient.instances[0].lastParams;
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'sys');
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ]
  });
});

test('streamOpenAI: sends plain string content when there is no image', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].lastParams.messages[1].content, 'hi');
});

test('streamOpenAI (nvidia): constructs the client with the NVIDIA base URL, no OpenRouter headers', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'nvidia', apiKeys: { nvidia: 'nvapi-x' }, models: { nvidia: { fast: 'some/model' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].opts.baseURL, 'https://integrate.api.nvidia.com/v1');
  assert.equal(OpenAIClient.instances[0].opts.defaultHeaders, undefined);
});

test('streamOpenAI (openrouter): constructs the client with OpenRouter headers', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.deepEqual(OpenAIClient.instances[0].opts.defaultHeaders, { 'HTTP-Referer': 'https://github.com/daydroidmuchiri/cue', 'X-Title': 'cue' });
});

test('streamOpenAI (openrouter): retries against the free router on a retriable error with no tokens emitted', async () => {
  let call = 0;
  const instances = [];
  class FlakyThenFreeClient {
    constructor(opts) { this.opts = opts; instances.push(this); }
    get chat() {
      const self = this;
      return { completions: { create: async (params) => {
        self.lastParams = params;
        call++;
        if (call === 1) { const e = new Error('no endpoints found'); e.status = 404; throw e; }
        return (async function* () { yield { choices: [{ delta: { content: 'fallback ok' } }] }; })();
      } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: FlakyThenFreeClient }
  );
  const full = await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(full, 'fallback ok');
  assert.equal(call, 2);
  assert.equal(instances[1].lastParams.model, OPENROUTER_FREE_MODEL);
});

test('streamAnthropic: passes system as a top-level param, not inside messages', async () => {
  const AnthropicClient = makeFakeAnthropic([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi there' } }
  ]);
  const llm = createLLM(
    { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-x' }, models: { anthropic: { fast: 'claude-3-5-haiku-latest' } }, smart: false },
    { AnthropicClient }
  );
  const full = await llm.stream({ system: 'sys prompt', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(full, 'hi there');
  const { system, messages } = AnthropicClient.instances[0].lastParams;
  assert.equal(system, 'sys prompt');
  assert.equal(messages.every((m) => m.role !== 'system'), true, 'system must not appear inside the messages array');
});

test('streamAnthropic: attaches the image as a base64 source before the text block', async () => {
  const AnthropicClient = makeFakeAnthropic([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }]);
  const llm = createLLM(
    { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-x' }, models: { anthropic: { fast: 'claude-3-5-haiku-latest' } }, smart: false },
    { AnthropicClient }
  );
  await llm.stream({
    system: 'sys', turns: [{ role: 'user', text: 'describe this' }],
    imageDataUrl: 'data:image/jpeg;base64,ZZZZ', onToken: () => {}
  });
  const { messages } = AnthropicClient.instances[0].lastParams;
  assert.deepEqual(messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZZ' } },
    { type: 'text', text: 'describe this' }
  ]);
});

test('streamAnthropic: ignores non-text-delta events (e.g. content_block_start)', async () => {
  const AnthropicClient = makeFakeAnthropic([
    { type: 'content_block_start' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'only this' } }
  ]);
  const llm = createLLM(
    { provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-x' }, models: { anthropic: { fast: 'claude-3-5-haiku-latest' } }, smart: false },
    { AnthropicClient }
  );
  const full = await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(full, 'only this');
});

test('streamGemini: maps assistant role to model and passes system via systemInstruction', async () => {
  const GoogleGenAIClient = makeFakeGemini([{ text: 'hi', candidates: [{ finishReason: 'STOP' }] }]);
  const llm = createLLM(
    { provider: 'gemini', apiKeys: { gemini: 'AIza-x' }, models: { gemini: { fast: 'gemini-2.5-flash' } }, smart: false },
    { GoogleGenAIClient }
  );
  const full = await llm.stream({
    system: 'sys prompt',
    turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'prior reply' }],
    onToken: () => {}
  });
  assert.equal(full, 'hi');
  const { contents, config } = GoogleGenAIClient.instances[0].lastParams;
  assert.equal(config.systemInstruction, 'sys prompt');
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
});

test('streamGemini: attaches the image as inlineData on the last user turn', async () => {
  const GoogleGenAIClient = makeFakeGemini([{ text: 'ok' }]);
  const llm = createLLM(
    { provider: 'gemini', apiKeys: { gemini: 'AIza-x' }, models: { gemini: { fast: 'gemini-2.5-flash' } }, smart: false },
    { GoogleGenAIClient }
  );
  await llm.stream({
    system: 'sys', turns: [{ role: 'user', text: 'describe this' }],
    imageDataUrl: 'data:image/png;base64,QQQQ', onToken: () => {}
  });
  const { contents } = GoogleGenAIClient.instances[0].lastParams;
  assert.deepEqual(contents[0].parts, [{ text: 'describe this' }, { inlineData: { mimeType: 'image/png', data: 'QQQQ' } }]);
});

test('a caller-supplied maxTokens overrides DEFAULT_MAX_TOKENS', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], maxTokens: 1024, onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].lastParams.max_tokens, 1024);
});

test('an unset maxTokens falls back to DEFAULT_MAX_TOKENS', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openai', apiKeys: { openai: 'sk-x' }, models: { openai: { fast: 'gpt-4o-mini' } }, smart: false },
    { OpenAIClient }
  );
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(OpenAIClient.instances[0].lastParams.max_tokens, DEFAULT_MAX_TOKENS);
});

test('onRetry fires once, with the failed model, before the free-router fallback', async () => {
  let call = 0;
  class RateLimitedThenFreeClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      const self = this;
      return { completions: { create: async (params) => {
        self.lastParams = params;
        call++;
        if (call === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return (async function* () { yield { choices: [{ delta: { content: 'fallback ok' } }] }; })();
      } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: RateLimitedThenFreeClient }
  );
  const retries = [];
  const full = await llm.stream({
    system: 'sys', turns: [{ role: 'user', text: 'hi' }],
    onRetry: (info) => retries.push(info),
    onToken: () => {}
  });
  assert.equal(full, 'fallback ok');
  assert.equal(retries.length, 1, 'exactly one retry notification');
  assert.equal(retries[0].model, 'some/model:free', 'reports the model that failed, not the fallback');
  assert.equal(retries[0].status, 429);
});

test('onRetry does not fire on a successful first attempt', async () => {
  const OpenAIClient = makeFakeOpenAI([{ choices: [{ delta: { content: 'ok' } }] }]);
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient }
  );
  let fired = false;
  await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} });
  assert.equal(fired, false);
});

test('onRetry does not fire on a non-retriable error', async () => {
  class UnauthorizedClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => { const e = new Error('bad key'); e.status = 401; throw e; } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: UnauthorizedClient }
  );
  let fired = false;
  await assert.rejects(() => llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} }));
  assert.equal(fired, false, '401 must surface as-is, not look like a retry');
});

test('onRetry does not fire once tokens have already streamed', async () => {
  // Mirrors the emittedAny guard: a mid-stream failure must not retry at all,
  // so it must not claim to be retrying either.
  class FailsMidStreamClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => (async function* () {
        yield { choices: [{ delta: { content: 'partial' } }] };
        const e = new Error('rate limited'); e.status = 429; throw e;
      })() } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: FailsMidStreamClient }
  );
  let fired = false;
  await assert.rejects(() => llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onRetry: () => { fired = true; }, onToken: () => {} }));
  assert.equal(fired, false);
});

test('an omitted onRetry does not throw when a retry happens', async () => {
  let call = 0;
  class FlakyClient {
    constructor(opts) { this.opts = opts; }
    get chat() {
      return { completions: { create: async () => {
        call++;
        if (call === 1) { const e = new Error('rate limited'); e.status = 429; throw e; }
        return (async function* () { yield { choices: [{ delta: { content: 'ok' } }] }; })();
      } } };
    }
  }
  const llm = createLLM(
    { provider: 'openrouter', apiKeys: { openrouter: 'sk-or-x' }, models: { openrouter: { fast: 'some/model:free' } }, smart: false },
    { OpenAIClient: FlakyClient }
  );
  const full = await llm.stream({ system: 'sys', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(full, 'ok');
});
