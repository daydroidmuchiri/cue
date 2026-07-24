const assert = require('node:assert/strict');
const test = require('node:test');
const { withTimeout, createLLM, resolveBaseURL, isRetriableOpenRouterError, OPENROUTER_FREE_MODEL, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } = require('../src/llm');

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

test('OPENROUTER_FREE_MODEL is the stable router id used as a retry target', () => {
  assert.equal(OPENROUTER_FREE_MODEL, 'openrouter/free');
});

test('DEFAULT_MAX_TOKENS is generous enough for a full solution + explanation', () => {
  assert.ok(DEFAULT_MAX_TOKENS >= 8000);
});

test('REQUEST_TIMEOUT_MS is a sane positive duration', () => {
  assert.ok(REQUEST_TIMEOUT_MS > 10000);
});
