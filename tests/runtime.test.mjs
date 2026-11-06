import test from 'node:test';
import assert from 'node:assert/strict';
import { captureContext, connectionId, holdSendState, requestJournal, telegramPing, saveSettingsVerified, fitContext, generateEntry, checkStorage, recoverIndex } from '../runtime.mjs';
import { JOURNAL_INSTRUCTION } from '../content.mjs';
const emitter = () => { const hooks = new Map(); return { on(n, fn) { if (!hooks.has(n)) hooks.set(n, []); hooks.get(n).push(fn); }, makeLast(n, fn) { this.on(n, fn); }, removeListener(n, fn) { hooks.set(n, (hooks.get(n) || []).filter(x => x !== fn)); }, async emit(n, ...args) { for (const fn of [...hooks.get(n) || []]) await fn(...args); }, count: n => (hooks.get(n) || []).length }; };
test('journal releases its own ST busy flag even though isGenerating reads true', async () => {
    const events = emitter(); let isSendPress = false;
    const host = { eventSource: events, event_types: { GENERATION_STARTED: 'started' }, setSendButtonState: value => { isSendPress = value; }, isGenerating: () => isSendPress };
    const release = holdSendState(host);
    assert.equal(host.isGenerating(), true);
    await events.emit('started', 'quiet', { automatic_trigger: true }, true);
    release(); release();
    assert.equal(host.isGenerating(), false); assert.equal(events.count('started'), 0);
});
test('a real generation takes ownership so journal cleanup leaves its flag intact', async () => {
    const events = emitter(); let isSendPress = false;
    const host = { eventSource: events, event_types: { GENERATION_STARTED: 'started' }, setSendButtonState: value => { isSendPress = value; }, isGenerating: () => isSendPress };
    const release = holdSendState(host);
    await events.emit('started', 'normal', {}, false);
    release(); assert.equal(host.isGenerating(), true); assert.equal(events.count('started'), 0);
});
function fixture() {
    const settings = { chat_completion_source: 'custom', custom_url: 'https://provider.example/v1', temp_openai: 0.6, stream_openai: true, openai_max_tokens: 120, openai_max_context: 16000, function_calling: true };
    const c = { mainApi: 'openai', chatCompletionSettings: settings, getTokenCountAsync: async text => Math.ceil(text.length / 4), getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture' }) };
    let built, posted;
    const api = { getChatCompletionModel: () => 'fixture-model', createGenerationParameters: async (s, model, type, messages) => { built = { s, model, type, messages }; return { generate_data: { messages, custom_include_body: JSON.stringify({ keep: 1, temperature: 0.2, messages: [], venice_parameters: { strip_thinking_response: true } }), custom_exclude_body: '', tools: ['bad'], stream: true } }; } };
    const snapshot = { messages: [{ role: 'system', content: 'Ava card and constant HER WORLD' }, { role: 'user', content: 'Yesterday message' }], user: 'Joe', character: 'Ava', timezone: 'Europe/London', connection: connectionId(c, api) };
    const fetcher = async (url, options) => { posted = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'fixture reply' }, finish_reason: 'stop' }] }) }; };
    return { c, api, snapshot, fetcher, countMessageTokens: async message => 4 + Math.ceil((message.content || '').length / 4), yaml: { parse: JSON.parse }, built: () => built, posted: () => posted };
}
test('journal uses ST context assembly dry-run; no visible generation or added message', async () => {
    const events = emitter(); let call;
    const host = { eventSource: events, event_types: { GENERATE_AFTER_DATA: 'data' }, Generate: async (...args) => { call = args; await events.emit('data', { prompt: [{ role: 'system', content: 'card plus lorebook' }] }, true); } };
    assert.deepEqual(await captureContext({ host, c: {}, guard() {} }), [{ role: 'system', content: 'card plus lorebook' }]);
    assert.deepEqual(call, ['quiet', { automatic_trigger: true }, true]); assert.equal(events.count('data'), 0);
});
test('journal request uses copied settings, native quiet type and exact last user instruction', async () => {
    const f = fixture(), before = structuredClone(f.c.chatCompletionSettings);
    const raw = await requestJournal({ ...f, date: '2026-11-05', guard() {} });
    assert.equal(raw, 'fixture reply'); assert.deepEqual(f.c.chatCompletionSettings, before);
    assert.equal(f.built().type, 'quiet'); assert.equal(f.built().s.temp_openai, 0.95);
    const p = f.posted(); assert.equal(p.temperature, 0.95); assert.equal(p.stream, false); assert.equal(p.n, 1); assert.equal(p.tools, undefined);
    assert.equal(p.messages.at(-1).content, JOURNAL_INSTRUCTION.replaceAll('{{user}}', 'Joe'));
    const custom = JSON.parse(p.custom_include_body); assert.equal(custom.keep, 1); assert.equal(custom.venice_parameters.strip_thinking_response, true); assert.equal(custom.temperature, undefined); assert.equal(custom.messages, undefined);
});
test('different connection cannot silently use another character connection for backfill', async () => {
    const f = fixture(); f.c.chatCompletionSettings.custom_url = 'https://other.example';
    await assert.rejects(requestJournal({ ...f, date: '2026-11-05', guard() {} }), /Select the connection/);
});
test('conversation resumes during provider request: result is rejected entirely', async () => {
    const f = fixture(); let resumed = false;
    f.fetcher = async () => { resumed = true; return { ok: true, json: async () => ({ choices: [{ message: { content: 'must be discarded' } }] }) }; };
    await assert.rejects(requestJournal({ ...f, date: '2026-11-05', guard() { if (resumed) throw Error('discard'); } }), /discard/);
});
test('unsolicited tool call never executes or becomes a journal', async () => {
    const f = fixture(); f.fetcher = async () => ({ ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{}], content: 'text' } }] }) });
    await assert.rejects(requestJournal({ ...f, date: '2026-11-05', guard() {} }), /Nothing executed/);
});
test('native settings-save silent failure is detected', async () => {
    const events = emitter(), host = { eventSource: events, event_types: { SETTINGS_UPDATED: 'settings' }, saveSettings: async () => {} };
    await assert.rejects(saveSettingsVerified(host), /not saved/); assert.equal(events.count('settings'), 0);
    host.saveSettings = () => events.emit('settings'); await saveSettingsVerified(host); assert.equal(events.count('settings'), 0);
});
test('Telegram notice is generic, audible and contains no entry or title', async () => {
    let data;
    await telegramPing({ token: '12345:fixture', chatId: '123', fetcher: async (url, opts) => { data = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; } });
    assert.deepEqual(data, { chat_id: '123', text: 'Ava wrote a journal entry.', disable_notification: false });
});
test('context trimming retains all system instructions and final journal instruction', async () => {
    const messages = [{ role: 'system', content: 'card' }, { role: 'user', content: 'old '.repeat(100) }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'recent' }, { role: 'assistant', content: 'recent answer' }, { role: 'system', content: 'previous journal' }, { role: 'user', content: 'fixed instruction' }];
    const fitted = await fitContext(messages, async message => message.content.length, 300);
    assert.equal(fitted[0].content, 'card'); assert.equal(fitted.at(-1).content, 'fixed instruction'); assert.ok(fitted.some(m => m.content === 'previous journal')); assert.equal(messages.length, 7);
});
test('per-message counts are summed once without JSON prompt overhead or repeated token calls', async () => {
    const messages = [{ role: 'system', content: 'card' }, { role: 'user', content: 'old' }, { role: 'assistant', content: 'reply', name: 'Ava' }, { role: 'system', content: 'previous' }, { role: 'user', content: 'fixed' }];
    const counted = [];
    const count = async message => { assert.equal(typeof message, 'object'); counted.push(structuredClone(message)); return 10; };
    assert.deepEqual(await fitContext(messages, count, 50), messages, 'no over-trimming at the exact boundary');
    assert.deepEqual(counted, messages, 'role and name passed intact to native message tokenizer');
    counted.length = 0;
    assert.deepEqual((await fitContext(messages, count, 40)).map(m => m.content), ['card', 'previous', 'fixed']);
    assert.equal(counted.length, 5, 'each message counted once even after trimming');
    await assert.rejects(fitContext(messages, async () => NaN, 50), /could not count/);
});
test('low-context error reports configured limit and required minimum', async () => {
    const f = fixture(); f.c.chatCompletionSettings.openai_max_context = 2048;
    await assert.rejects(requestJournal({ ...f, date: '2026-11-05', guard() {} }), /at least 3200.*2048.*2200/);
    assert.equal(f.posted(), undefined);
});
const validEntry = `TITLE: The small quiet notebook\n\n${Array(30).fill('I kept the small notebook.').join(' ')}`;
test('word-count failure gets exactly one retry; successful body is preserved', async () => {
    let calls = 0, retries = 0;
    const parsed = await generateEntry({ generate: async () => ++calls === 1 ? 'short' : validEntry, guard() {}, onRetry() { retries++; } });
    assert.equal(calls, 2); assert.equal(retries, 1); assert.equal(parsed.body, validEntry.split('\n\n')[1]);
});
test('second word-count failure stops; other parsing and provider failures do not retry', async () => {
    let calls = 0;
    await assert.rejects(generateEntry({ generate: async () => { calls++; return 'short'; }, guard() {} }), /expected 150/);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(generateEntry({ generate: async () => { calls++; return Array(150).fill('oversized').join(' '); }, guard() {} }), /closing beat/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(generateEntry({ generate: async () => { calls++; throw Error('provider offline'); }, guard() {} }), /provider offline/);
    assert.equal(calls, 1);
});
test('conversation resume between retries prevents the second request entirely', async () => {
    let calls = 0, resumed = false;
    await assert.rejects(generateEntry({ generate: async () => { calls++; return 'short'; }, guard() { if (resumed) throw Error('discard'); }, onRetry() { resumed = true; } }), /discard/);
    assert.equal(calls, 1);
});
function storageFixture({ collision = false, corrupt = false, malformedVerify = false, failRead = false, failDelete = false } = {}) {
    const id = '00000000-0000-4000-8000-000000000001';
    const url = `/user/files/ava-journal-check-${id}.txt`;
    const files = new Map(collision ? [[url, 'pre-existing']] : []), calls = [];
    const fetcher = async (path, options) => {
        calls.push(path);
        assert.equal(options.headers['X-CSRF-Token'], 'fixture');
        assert.ok(options.signal);
        const data = options.body ? JSON.parse(options.body) : null;
        if (path === '/api/files/verify') return { ok: true, json: async () => malformedVerify ? [] : Object.fromEntries(data.urls.map(u => [u, files.has(u)])) };
        if (path === '/api/files/upload') {
            assert.equal(files.has(url), false);
            files.set(url, Buffer.from(data.data, 'base64').toString('utf8'));
            return { ok: true, json: async () => ({ path: url }) };
        }
        if (path === url) return { ok: !failRead, status: 404, text: async () => corrupt ? 'different file' : files.get(url) };
        if (path === '/api/files/delete') {
            assert.equal(data.path, url);
            if (!failDelete) files.delete(url);
            return { ok: !failDelete, status: 500 };
        }
        throw Error('Unexpected call');
    };
    return { id, url, files, calls, fetcher, headers: () => ({ 'X-CSRF-Token': 'fixture', 'Content-Type': 'application/json' }) };
}
test('storage preflight verifies live API contract, exact UTF-8 readback and own-probe cleanup', async () => {
    const f = storageFixture();
    assert.deepEqual(await checkStorage(f), { upload: true, verify: true, read: true, cleanup: true });
    assert.equal(f.files.size, 0);
    assert.deepEqual(f.calls, ['/api/files/verify', '/api/files/upload', '/api/files/verify', f.url, '/api/files/delete', '/api/files/verify']);
});
test('storage preflight never overwrites a collision or deletes a mismatched file', async () => {
    const collision = storageFixture({ collision: true });
    await assert.rejects(checkStorage(collision), /already exists/);
    assert.deepEqual(collision.calls, ['/api/files/verify']); assert.equal(collision.files.get(collision.url), 'pre-existing');
    const corrupt = storageFixture({ corrupt: true });
    await assert.rejects(checkStorage(corrupt), /did not match/);
    assert.ok(!corrupt.calls.includes('/api/files/delete'));
});
test('storage gate rejects unexpected verify shape, unreadable files and cleanup failures', async () => {
    await assert.rejects(checkStorage(storageFixture({ malformedVerify: true })), /could not verify/);
    await assert.rejects(checkStorage(storageFixture({ failRead: true })), /HTTP 404/);
    await assert.rejects(checkStorage(storageFixture({ failDelete: true })), /HTTP 500/);
});
test('index recovery skips an empty closing beat while keeping a valid entry', async () => {
    const db = { entries: [] }, avatar = 'Ava.png';
    const settings = { character_attachments: { [avatar]: [1, 2].map(n => ({ url: `/user/files/ava-log-2026-11-06-${n}.md` })) } };
    const meta = JSON.stringify({ avatar, title: 'Recovered journal title', date: '2026-11-06', chat_id: 'chat', written_at: '2026-11-06T12:00:00Z' });
    await recoverIndex({ db, settings, avatar, yaml: { parse: JSON.parse }, read: async url => `---\n${meta}\n---\n${url.endsWith('-1.md') ? '   ' : 'A real closing sentence.'}` });
    assert.equal(db.entries.length, 1); assert.equal(db.entries[0].beat, 'A real closing sentence.');
});
