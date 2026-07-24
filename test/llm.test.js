const assert = require('node:assert/strict');
const test = require('node:test');
const { withTimeout, createLLM, DEFAULT_MAX_TOKENS, REQUEST_TIMEOUT_MS } = require('../src/llm');

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

test('DEFAULT_MAX_TOKENS is generous enough for a full solution + explanation', () => {
  assert.ok(DEFAULT_MAX_TOKENS >= 8000);
});

test('REQUEST_TIMEOUT_MS is a sane positive duration', () => {
  assert.ok(REQUEST_TIMEOUT_MS > 10000);
});
