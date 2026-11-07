import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as core from '../core.mjs';
import * as runtime from '../runtime.mjs';
import { JOURNAL_INSTRUCTION } from '../content.mjs';

async function harness() {
    const nodes = new Map();
    class Element {
        constructor() { this.children = []; this.value = ''; this.checked = false; this.textContent = ''; }
        set innerHTML(html) { for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, new Element()); }
        querySelector(selector) { return nodes.get(selector.slice(1)); }
        append(...items) { this.children.push(...items); }
        replaceChildren(...items) { this.children = items; }
        addEventListener() {}
        click() {}
    }
    for (const id of ['extensions_settings', 'send_textarea']) nodes.set(id, new Element());
    const document = { createElement: () => new Element(), getElementById: id => nodes.get(id), addEventListener() {}, body: new Element() };
    const names = ['SETTINGS_UPDATED','GENERATE_AFTER_DATA','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_COMPLETION_PROMPT_READY','CHAT_COMPLETION_SETTINGS_READY','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','CHAT_CHANGED','CHAT_LOADED'];
    const hooks = new Map(), events = {
        on(n, f) { hooks.set(n, [...(hooks.get(n) || []), f]); }, makeLast(n, f) { this.on(n, f); },
        removeListener(n, f) { hooks.set(n, (hooks.get(n) || []).filter(x => x !== f)); },
        async emit(n, ...args) { for (const f of [...(hooks.get(n) || [])]) await f(...args); },
    };
    let time = Date.parse('2026-11-07T17:00:00Z');
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
    const ctx = { mainApi: 'openai', characterId: 0, characters: [{ avatar: 'Ava.png' }], chatId: 'ava-chat', name1: 'Joe', name2: 'Ava', chat: [], chatCompletionSettings: { chat_completion_source: 'custom', custom_url: 'fixture', openai_max_context: 16000 } };
    const messages = name => Array.from({ length: 8 }, (_, i) => ({ mes: `${name} private message ${i}`, is_user: i % 2 === 0, send_date: time - 10000 + i }));
    ctx.chat = messages('Ava');
    const extension_settings = { 'ava-journal': { avatar: 'Ava.png', enabled: true, timezone: 'Europe/London', sceneHold: false, telegram: false } };
    let stored = core.newDatabase(), serverConfig, busy = false, failSave = false;
    const savedFiles = new Map(), requests = [], heldLocks = new Set();
    const host = { eventSource: events, event_types: Object.fromEntries(names.map(n => [n, n])),
        isGenerating: () => busy, setSendButtonState: v => { busy = v; }, getRequestHeaders: () => ({}),
        async saveSettings() { if (!failSave) { serverConfig = structuredClone(extension_settings); await events.emit('SETTINGS_UPDATED'); } },
        async Generate(_, __, dry) { assert.equal(dry, true); await events.emit('GENERATE_AFTER_DATA', { prompt: [{ role: 'system', content: ctx.name2 + ' CARD ONLY' }, ...ctx.chat.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes }))] }, true); },
    };
    const api = { getChatCompletionModel: () => 'fixture-model' };
    const modules = {
        '../../../../script.js': host, '../../../extensions.js': { extension_settings, getContext: () => ctx }, '../../../openai.js': api,
        '../../../chats.js': { hasPendingFileAttachment: () => false }, '../../../user.js': { getCurrentUserHandle: () => 'joe' },
        '../../../utils.js': { timestampToMoment: v => ({ valueOf: () => v }) }, '../../../../lib.js': { yaml: {} },
        '../../../tokenizers.js': { countTokensOpenAIAsync: async () => 1 }, './core.mjs': core,
        './runtime.mjs': { ...runtime,
            openStore: async () => ({ read: async () => structuredClone(stored), write: async data => { stored = structuredClone(data); } }),
            checkStorage: async () => {}, recoverIndex: async () => false,
            fileApi: () => ({ verify: async url => savedFiles.has(url), read: async url => savedFiles.get(url), upload: async (name, text) => { const url = '/user/files/' + name; savedFiles.set(url, text); return url; } }),
            requestJournal: async args => { args.guard(); requests.push(core.journalMessages(args.snapshot, args.date, args.previous, args.instruction)); return 'TITLE: A private journal entry\n\n' + Array.from({ length: 30 }, () => 'I kept my own notes.').join(' '); },
        },
    };
    const context = vm.createContext({ console, document, window: { addEventListener() {} }, navigator: { locks: { async request(key, _, fn) { if (heldLocks.has(key)) return fn(null); heldLocks.add(key); try { return await fn({}); } finally { heldLocks.delete(key); } } } },
        structuredClone, Date: Clock, Intl, AbortController, TextEncoder, Blob, URL,
        setTimeout: () => 1, clearTimeout() {}, setInterval() {}, BroadcastChannel: undefined,
    });
    const cache = new Map();
    async function moduleFor(spec) {
        if (!cache.has(spec)) {
            const exports = modules[spec]; assert.ok(exports, spec);
            const module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
            cache.set(spec, module); await module.link(() => {}); await module.evaluate();
        }
        return cache.get(spec);
    }
    const main = new vm.SourceTextModule(await readFile(new URL('../index.js', import.meta.url), 'utf8'), { context, importModuleDynamically: moduleFor });
    await main.link(moduleFor); await main.evaluate();
    const app = await main.namespace.boot();
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
    return { app, nodes, ctx, extension_settings, requests, savedFiles, events, flush,
        get serverConfig() { return serverConfig; }, failSave: value => { failSave = value; }, advance: ms => { time += ms; },
        async switchTo(name, avatar = name + '.png') { ctx.characters = [{ avatar }]; ctx.name2 = name; ctx.chatId = name + '-chat'; ctx.chat = messages(name); await events.emit('CHAT_CHANGED'); },
        async enable(value = true) { const target = nodes.get('aj-enabled'); target.checked = value; await target.onchange({ target }); await flush(); },
    };
}

test('real panel migrates Ava, enables Eve independently, isolates writes/read-back and restores Ava on switch', async () => {
    const h = await harness();
    assert.equal(h.nodes.get('aj-enabled').checked, true);
    assert.equal(h.nodes.get('aj-instruction').value, JOURNAL_INSTRUCTION);
    await h.app.tick(true); assert.equal(h.app.snapshot().entries.length, 1);
    await h.switchTo('Eve March', 'Eve.png');
    assert.equal(h.nodes.get('aj-enabled').checked, false);
    assert.equal(h.nodes.get('aj-entries').children.length, 0);
    assert.doesNotMatch(h.nodes.get('aj-instruction').value, /rationed sweetness/);
    await h.enable();
    assert.equal(h.extension_settings['ava-journal'].profiles['Ava.png'].enabled, true);
    assert.equal(h.extension_settings['ava-journal'].profiles['Eve.png'].enabled, true);
    await h.app.tick(true);
    assert.equal(h.app.snapshot().entries.length, 2);
    assert.equal(h.nodes.get('aj-entries').children.length, 1);
    assert.ok(JSON.stringify(h.requests.at(-1)).includes('Eve March CARD ONLY'));
    assert.ok(!JSON.stringify(h.requests.at(-1)).includes('Ava CARD ONLY'));
    await h.events.emit('GENERATION_STARTED', 'normal', {}, false);
    const event = { chat: [] }; await h.events.emit('CHAT_COMPLETION_PROMPT_READY', event);
    assert.ok(event.chat[0].content.startsWith("Eve March'S OWN PAST JOURNAL"));
    assert.equal(h.extension_settings.character_attachments['Ava.png'].length, 1);
    assert.equal(h.extension_settings.character_attachments['Eve.png'].length, 1);
    assert.equal(h.savedFiles.size, 2); assert.equal(h.ctx.chat.length, 8);
    await h.switchTo('Ava');
    assert.equal(h.nodes.get('aj-enabled').checked, true);
    assert.equal(h.nodes.get('aj-instruction').value, JOURNAL_INSTRUCTION);
    assert.equal(h.nodes.get('aj-entries').children.length, 1);
});

test('failed profile save restores both characters without changing server settings', async () => {
    const h = await harness(); await h.switchTo('Eve'); await h.enable();
    const before = structuredClone(h.extension_settings['ava-journal']);
    h.failSave(true);
    const target = h.nodes.get('aj-hold'); target.checked = true; await target.onchange({ target });
    assert.deepEqual(h.extension_settings['ava-journal'], before);
    assert.deepEqual(h.serverConfig['ava-journal'], before);
    assert.equal(target.checked, false);
});

test('automatic jobs for both profiles use saved owner context even while the other chat is open', async () => {
    const h = await harness(); await h.app.tick();
    await h.switchTo('Eve'); await h.enable();
    h.advance(2 * 60 * 60 * 1000);
    await h.app.tick(); await h.app.tick();
    const entries = h.app.snapshot().entries;
    assert.deepEqual(entries.map(e => e.avatar).sort(), ['Ava.png', 'Eve.png']);
    assert.equal(h.ctx.name2, 'Eve');
    assert.equal(h.requests.length, 2);
    for (const messages of h.requests) {
        const text = JSON.stringify(messages);
        assert.notEqual(text.includes('Ava CARD ONLY'), text.includes('Eve CARD ONLY'));
    }
    assert.equal(h.nodes.get('aj-entries').children.length, 1);
});

test('editing Eve instructions leaves Ava exact and never edits either card', async () => {
    const h = await harness(); await h.switchTo('Eve'); await h.enable();
    const before = structuredClone(h.ctx.characters);
    h.nodes.get('aj-instruction').value = 'Eve custom diary direction';
    await h.nodes.get('aj-save-instruction').onclick();
    assert.equal(h.extension_settings['ava-journal'].profiles['Eve.png'].instruction, 'Eve custom diary direction');
    assert.equal(h.extension_settings['ava-journal'].profiles['Ava.png'].instruction, JOURNAL_INSTRUCTION);
    assert.deepEqual(h.ctx.characters, before);
});
