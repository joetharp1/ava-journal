// Exercises real control callbacks and HTTP routes with a minimal DOM adapter.
// This validates behavior, not layout or a live SillyTavern browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCalendarControls } from '../arc/controls.mjs';
import { registerRoutes } from '../arc/server.mjs';
import { createFileStore } from '../arc/server-store.mjs';

function harness(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ui-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nodes = new Map(), hooks = new Map(), docHooks = new Map(), surfaceHooks = new Map();
    class Element {
        constructor() { this.children = []; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.textContent = ''; }
        set innerHTML(html) {
            for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
                const node = new Element(), tag = match[0]; node.hidden = /\bhidden\b/.test(tag); node.value = tag.match(/value="([^"]*)"/)?.[1] || '';
                nodes.set(match[1], node);
            }
        }
        querySelector(selector) { return nodes.get(selector.replace(/^#/, '')); }
        append(...items) { this.children.push(...items); }
        replaceChildren(...items) { this.children = items; this.value = items[0]?.value || ''; }
        addEventListener(name, fn) { this.listeners.set(name, fn); }
        click() { if (!this.disabled) this.listeners.get('click')?.(); }
    }
    const body = new Element(), panel = { querySelector: () => body };
    const document = { hidden: false, createElement: () => new Element(), addEventListener: (n, f) => docHooks.set(n, f) };
    let time = Date.parse('2026-11-16T12:00:00Z'), seq = 0, failSave = false, pluginMissing = false, toolLoads = 0;
    const store = createFileStore(), routes = new Map(), calls = [];
    registerRoutes({ post: (p, f) => routes.set(p, f) }, { store, now: () => time, id: () => 'ui-identity-' + ++seq, decide: () => false });
    const context = { characters: [{ avatar: 'Ava.png' }, { avatar: 'Eve.png' }], characterId: 0, chatId: 'ava-chat' };
    const ext = { extension_settings: {}, getContext: () => context };
    const host = { getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), isGenerating: () => false,
        event_types: Object.fromEntries(['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED'].map(x => [x, x])),
        eventSource: { on: (n, f) => hooks.set(n, f) } };
    const surface = { setInterval: fn => surfaceHooks.set('interval', fn), setTimeout() {}, addEventListener: (n, f) => surfaceHooks.set(n, f),
        async fetch(url, opts) {
            calls.push(url); if (pluginMissing) return { ok: false, status: 404, json: async () => { throw Error(); } };
            let status = 200, result;
            routes.get(url.split('/ava-calendar')[1])({ body: JSON.parse(opts.body), user: { profile: { handle: 'joe' }, directories: { root } } }, {
                setHeader() {}, status(n) { status = n; return this; }, json(v) { result = v; },
            });
            return { ok: status === 200, status, json: async () => result };
        } };
    const manager = { registerFunctionTool() {}, unregisterFunctionTool() {}, isToolCallingSupported: () => false };
    const controls = installCalendarControls({ host, ext, panel, surface, document,
        saveSettings: async () => { if (failSave) throw Error('Settings not saved.'); }, loadTools: async () => { toolLoads++; return { ToolManager: manager }; } });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
    const el = name => nodes.get('ac-' + name);
    const click = async name => { el(name).click(); await settle(); };
    const configure = async () => {
        await click('refresh'); el('confirm').checked = true; el('date').value = '2026-11-04'; el('type').value = 'cycle'; await click('configure');
    };
    return { root, store, nodes, el, click, configure, settle, context, ext, controls, calls, hooks, docHooks, surfaceHooks, document,
        setFailSave: v => { failSave = v; }, setPluginMissing: v => { pluginMissing = v; }, setTime: v => { time = Date.parse(v); }, toolLoads: () => toolLoads };
}
test('controls start inert; explicit setup binds Ava and presents state with a manual fallback', async t => {
    const h = harness(t); await h.settle(); assert.equal(h.calls.length, 0); assert.equal(h.toolLoads(), 0);
    await h.click('refresh'); assert.equal(h.el('setup').hidden, false);
    await h.click('configure'); assert.match(h.el('status').textContent, /Confirm/); assert.equal(h.store.read(h.root).record, null);
    await h.configure(); assert.equal(h.ext.extension_settings['ava-calendar'].avatar, 'Ava.png');
    assert.match(h.el('state').textContent, /cycle day 13/); assert.match(h.el('tool-status').textContent, /Manual completion/);
    assert.equal(h.toolLoads(), 1); assert.equal(h.el('setup').hidden, true); assert.equal(h.el('existing').hidden, false);
});
test('missing server never offers creation or changes binding', async t => {
    const h = harness(t); h.setPluginMissing(true); await h.click('refresh');
    assert.match(h.el('status').textContent, /unavailable/); assert.equal(h.el('setup').hidden, true);
    assert.equal(h.ext.extension_settings['ava-calendar'], undefined);
});
test('failed settings save preserves the server record and allows explicit reconnect', async t => {
    const h = harness(t); h.setFailSave(true); await h.configure();
    assert.match(h.el('status').textContent, /not saved/); assert.equal(h.ext.extension_settings['ava-calendar'], undefined);
    assert.equal(h.store.read(h.root).record.avatar, 'Ava.png');
    h.setFailSave(false); await h.click('refresh'); await h.click('connect');
    assert.equal(h.ext.extension_settings['ava-calendar'].avatar, 'Ava.png'); assert.equal(h.store.read(h.root).revision, 1);
});
test('manual encounter control records once, reload refresh shows result, and day override uses current revision', async t => {
    const h = harness(t); await h.configure(); await h.click('begin');
    for (const key of ['unprotected', 'penetrative', 'completion']) h.el(key).checked = true;
    await h.click('complete'); assert.match(h.el('encounter').textContent, /no conception/);
    const saved = h.store.read(h.root); assert.equal(saved.record.encounters.length, 1);
    await h.click('complete'); await h.click('refresh'); assert.equal(h.store.read(h.root).revision, saved.revision);
    h.el('day').value = '7'; await h.click('set-day'); assert.match(h.el('state').textContent, /day 7/);
    assert.equal(h.el('begin').disabled, true); await h.click('clear'); assert.match(h.el('state').textContent, /day 13/);
});
test('tab return and timer refresh the date, preserve untouched edit fields and keep other characters inert', async t => {
    const h = harness(t); await h.configure(); h.el('day').value = '22';
    await h.controls.tick(); assert.equal(h.el('day').value, '22');
    h.setTime('2026-11-17T12:00:00Z'); h.docHooks.get('visibilitychange')(); await h.settle();
    assert.match(h.el('state').textContent, /day 14/);
    h.context.characterId = 1; h.context.chatId = 'eve-chat'; const before = h.calls.length;
    h.hooks.get('CHAT_CHANGED')(); await h.settle(); h.surfaceHooks.get('interval')(); await h.settle();
    assert.equal(h.calls.length, before); assert.equal(h.el('existing').hidden, true);
    await h.click('refresh'); assert.match(h.el('status').textContent, /bound to Ava/); assert.equal(h.calls.length, before);
});
test('stale manual edits are rejected and a refresh lets Joe review current state', async t => {
    const h = harness(t); await h.configure();
    h.store.transaction(h.root, e => { e.record.bellyOverride = { arcId: e.record.arcId, value: 'flat' }; });
    h.el('day').value = '20'; await h.click('set-day'); assert.match(h.el('status').textContent, /changed/);
    assert.equal(h.store.read(h.root).record.override, null);
    await h.click('refresh'); h.el('day').value = '20'; await h.click('set-day'); assert.match(h.el('state').textContent, /day 20/);
});
