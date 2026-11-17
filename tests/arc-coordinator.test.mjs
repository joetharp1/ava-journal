import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecord, addDays, derive, setOverride, BIRTH_CURVE } from '../arc/core.mjs';
import { advanceCalendar, beginEncounter, appendEncounter, encounterView } from '../arc/coordinator.mjs';
import { createFileStore } from '../arc/server-store.mjs';
import { registerRoutes } from '../arc/server.mjs';
import { createArcBridge } from '../arc/client.mjs';
import { createCalendarApi, registerEncounterTool, saveCalendarBinding } from '../arc/controls.mjs';

const date = '2026-11-16', start = addDays(date, -400);
const pregnancy = () => createRecord({ avatar: 'Ava.png', id: 'test-pregnancy', arcType: 'pregnancy', startDate: start, today: date });
const cycle = () => createRecord({ avatar: 'Ava.png', id: 'test-cycle', arcType: 'cycle', startDate: addDays(date, -12), today: date });
function harness(t, { decide = () => false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-stage2-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let now = date, seq = 0;
    const store = createFileStore(), routes = new Map();
    registerRoutes({ post: (p, f) => routes.set(p, f) }, { store, now: () => Date.parse(now + 'T12:00:00Z'), id: () => 'canonical-id-' + ++seq, decide });
    const request = (p, body, userRoot = root) => {
        let status = 200, result;
        const res = { setHeader() {}, status(n) { status = n; return this; }, json(value) { result = value; } };
        routes.get('/' + p)({ body, user: { profile: { handle: 'joe' }, directories: { root: userRoot } } }, res);
        return { status, result };
    };
    const api = async (p, body) => { const { status, result } = request(p, body); if (status !== 200) throw Object.assign(new Error(result.error), { status, code: result.code }); return result; };
    return { root, store, api, request, setDate: d => { now = d; } };
}
test('missed birth dates run chronologically, stop at success, and derive postpartum from that date', () => {
    const r = pregnancy(), chances = [];
    advanceCalendar(r, addDays(start, 282), percent => { chances.push(percent); return chances.length === 4; });
    assert.deepEqual(chances, [5, 7, 10, 13]); assert.equal(r.birthDate, addDays(start, 276));
    assert.equal(derive(r, addDays(start, 282)).day, 6);
    advanceCalendar(r, addDays(start, 282), () => assert.fail('replayed'));
    assert.equal(Object.keys(r.daily).length, 4);
});
test('forced day 287 bypasses random draw, even after a long absence; cycle day derives from historical birth', () => {
    const r = pregnancy(), chances = [];
    advanceCalendar(r, date, p => { chances.push(p); return false; });
    assert.deepEqual(chances, BIRTH_CURVE.slice(0, -1));
    assert.equal(r.birthDate, addDays(start, 287)); assert.equal(Object.keys(r.daily).length, 15);
    assert.equal(r.arcType, 'cycle'); assert.equal(derive(r, date).day, 2);
});
test('future birth window has no random calls or daily writes', () => {
    const r = pregnancy(); advanceCalendar(r, addDays(start, 272), () => assert.fail());
    assert.deepEqual(r.daily, {}); assert.equal(r.birthCursor, undefined);
});
test('jumping to term day 280 rolls today once, with no retrospective birth or reroll on refresh', () => {
    const r = pregnancy(); setOverride(r, { kind: 'day', value: 280 }, date);
    const calls = []; advanceCalendar(r, date, p => { calls.push(p); return false; });
    advanceCalendar(r, date, () => assert.fail());
    assert.deepEqual(calls, [35]); assert.equal(Object.values(r.daily)[0].date, date);
    setOverride(r, { kind: 'day', value: 281 }, date);
    advanceCalendar(r, date, () => assert.fail('one date already has a receipt'));
    assert.equal(Object.keys(r.daily).length, 1);
});
test('manual birth transition is immediate and never invokes the daily runner', () => {
    const r = pregnancy(); setOverride(r, { kind: 'stage', value: 'birth' }, date);
    advanceCalendar(r, date, () => assert.fail());
    assert.equal(r.birthDate, date); assert.equal(r.arcType, 'postpartum'); assert.equal(derive(r, date).day, 0);
});
test('a failed roll followed by a same-day jump to 287 still forces birth without rerolling', () => {
    const r = pregnancy(); setOverride(r, { kind: 'day', value: 273 }, date);
    advanceCalendar(r, date, () => false);
    setOverride(r, { kind: 'day', value: 287 }, date);
    advanceCalendar(r, date, () => assert.fail('forced transition must not roll'));
    assert.equal(r.birthDate, date); assert.equal(r.lastTransition.cause, 'forced-day-287');
    assert.equal(Object.values(r.daily)[0].success, false);
});
test('birth catch-up and its cursor survive independent store instances and request repeats', async t => {
    let rolls = 0; const h = harness(t, { decide: () => { rolls++; return rolls === 3; } });
    h.store.transaction(h.root, e => { e.record = pregnancy(); }, 0);
    await Promise.all(Array.from({ length: 12 }, () => h.api('state', { avatar: 'Ava.png' })));
    assert.equal(rolls, 3); const saved = createFileStore().read(h.root);
    assert.equal(saved.record.birthDate, addDays(start, 275)); assert.equal(Object.keys(saved.record.daily).length, 3);
    assert.equal(saved.revision, 2);
});
test('manual opening establishes one identity; duplicate completion rolls once across reload and changed facts', async t => {
    let rolls = 0; const h = harness(t, { decide: () => { rolls++; return true; } });
    h.store.transaction(h.root, e => { e.record = cycle(); }, 0);
    const opened = await h.api('begin-encounter', { avatar: 'Ava.png', chatId: 'chat-a', expectedRevision: 1 });
    const event = { avatar: 'Ava.png', chatId: 'chat-a', encounterId: opened.encounter.id, event: 'completed_encounter', facts: { unprotected: true, penetrative: true, internalCompletion: true } };
    const first = await h.api('append-event', event);
    const second = await h.api('append-event', { ...event, facts: { unprotected: false, penetrative: false, internalCompletion: false } });
    assert.equal(first.state.arcType, 'pregnancy'); assert.equal(second.result.duplicate, true); assert.equal(rolls, 1);
    assert.equal(createFileStore().read(h.root).record.conceptionDate, date);
    assert.equal(h.request('begin-encounter', { avatar: 'Ava.png', chatId: 'chat-a', expectedRevision: 1 }).status, 409);
});
test('closed, expired, wrong-chat and other-character event calls cannot roll', async t => {
    const h = harness(t, { decide: () => assert.fail('must not roll') });
    h.store.transaction(h.root, e => { e.record = cycle(); }, 0);
    const opened = await h.api('begin-encounter', { avatar: 'Ava.png', chatId: 'a', expectedRevision: 1 });
    const body = { avatar: 'Ava.png', chatId: 'a', encounterId: opened.encounter.id, event: 'completed_encounter', facts: { unprotected: true, penetrative: true, internalCompletion: true } };
    for (const changed of [{ avatar: 'Eve.png' }, { chatId: 'b' }, { encounterId: 'invented' }, { event: 'write_journal' }, { facts: { ...body.facts, override: 'birth' } }])
        assert.ok(h.request('append-event', { ...body, ...changed }).status >= 400);
    h.setDate(addDays(date, 1)); assert.equal(h.request('append-event', body).status, 409);
    assert.equal(createFileStore().read(h.root).record.encounters.length, 0);
});
test('ineligible completion has no receipt; a later completion of the same encounter can qualify once', () => {
    const r = cycle(); beginEncounter(r, { chatId: 'a' }, date, () => 'id-1');
    const body = { chatId: 'a', encounterId: 'id-1', facts: { unprotected: true, penetrative: true, internalCompletion: false } };
    assert.equal(appendEncounter(r, body, date, () => assert.fail()).eligible, false);
    assert.equal(r.encounters.length, 0); body.facts.internalCompletion = true;
    appendEncounter(r, body, date, () => false); assert.equal(encounterView(r, date).open, false);
});
test('only an explicit new encounter permits a second roll; superseded identity fails closed', () => {
    const r = cycle(), facts = { unprotected: true, penetrative: true, internalCompletion: true };
    beginEncounter(r, { chatId: 'a' }, date, () => 'first'); appendEncounter(r, { chatId: 'a', encounterId: 'first', facts }, date, () => false);
    beginEncounter(r, { chatId: 'a' }, date, () => 'second');
    assert.throws(() => appendEncounter(r, { chatId: 'a', encounterId: 'first', facts }, date, () => assert.fail()), /changed/);
    assert.equal(appendEncounter(r, { chatId: 'a', encounterId: 'second', facts }, date, () => false).receipt.sequence, 2);
});
test('tool registration captures the issued encounter, excludes other chats, and never accepts model IDs', async t => {
    const h = harness(t); h.store.transaction(h.root, e => { e.record = cycle(); }, 0);
    await h.api('begin-encounter', { avatar: 'Ava.png', chatId: 'a', expectedRevision: 1 });
    let definition, permitted = true, target = { avatar: 'Ava.png', chatId: 'a', group: false };
    const uninstall = registerEncounterTool({ manager: { registerFunctionTool: x => { definition = x; }, unregisterFunctionTool: () => { definition = null; } },
        api: h.api, binding: () => ({ avatar: 'Ava.png' }), target: () => target, allowed: () => permitted });
    assert.equal(await definition.shouldRegister(), true);
    const facts = { unprotected: true, penetrative: true, internalCompletion: true };
    assert.equal((await definition.action(facts)).result.eligible, true);
    assert.equal((await definition.action(facts)).result.duplicate, true);
    target = { ...target, avatar: 'Eve.png' }; await assert.rejects(definition.action(facts), /No matching/);
    assert.equal(await definition.shouldRegister(), false);
    target = { avatar: 'Ava.png', chatId: 'a', group: false }; permitted = false;
    assert.equal(await definition.shouldRegister(), false); uninstall(); assert.equal(definition, null);
});
test('failed client settings save rolls binding back; server record remains available to reconnect', async () => {
    const ext = { extension_settings: {} };
    await assert.rejects(saveCalendarBinding({ ext, avatar: 'Ava.png', saveSettings: async () => { throw Error('save failed'); } }), /save failed/);
    assert.equal(ext.extension_settings['ava-calendar'], undefined);
    await saveCalendarBinding({ ext, avatar: 'Ava.png', saveSettings: async () => {} });
    assert.deepEqual(ext.extension_settings['ava-calendar'], { avatar: 'Ava.png' });
});
test('API reports missing server and server failures without treating them as empty calendars', async () => {
    const api = createCalendarApi({ headers: () => ({}), fetcher: async () => ({ ok: false, json: async () => { throw Error(); } }) });
    await assert.rejects(api('inspect', { avatar: 'Ava.png' }), /unavailable/);
});
test('private journal strips only the calendar event tool and retains other tool definitions', async () => {
    let sent;
    const bridge = createArcBridge({ binding: () => ({ avatar: 'Ava.png' }), target: () => null, headers: () => ({}), yaml: { parse: JSON.parse },
        fetcher: async (url, options) => {
            if (url.endsWith('/state')) return { ok: true, json: async () => ({ state: derive(cycle(), date) }) };
            sent = JSON.parse(options.body); return { ok: true };
        } });
    const data = { messages: [], tools: [{ type: 'function', function: { name: 'ava_append_arc_event' } }, { type: 'function', function: { name: 'memory' } }], tool_choice: { type: 'function', function: { name: 'ava_append_arc_event' } } };
    await bridge.forTarget({ avatar: 'Ava.png', chatId: 'a' })('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(data) });
    assert.deepEqual(sent.tools.map(t => t.function.name), ['memory']); assert.equal(sent.tool_choice, 'auto');
});
