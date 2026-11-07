import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig, characterSettings, updateCharacterConfig, planCharacters, newDatabase, recordKey, readBack, journalMessages, observe } from '../core.mjs';
import { JOURNAL_INSTRUCTION, READ_BACK, CHARACTER_JOURNAL_INSTRUCTION, CHARACTER_READ_BACK } from '../content.mjs';
import { telegramPing } from '../runtime.mjs';

const now = Date.parse('2026-11-07T22:00:00Z');
const legacy = { avatar: 'Ava.png', enabled: true, timezone: 'Europe/London', telegram: true, sceneHold: false };
function profiles() {
    let config = migrateConfig(legacy);
    for (const avatar of ['Eve.png', 'Marnie.png']) config = updateCharacterConfig(config, { ...characterSettings(config, avatar), enabled: true });
    return config;
}
function dbFor(config) {
    const db = newDatabase();
    for (const avatar of Object.keys(config.profiles)) db.records[recordKey(avatar, 'chat', '2026-11-07')] = {
        avatar, chatId: 'chat', date: '2026-11-07', count: 8, lastExchange: now - 7200000, retryAt: 0,
        snapshot: { avatar, chatId: 'chat', connection: 'same-model', messages: [{ role: 'system', content: avatar + ' ONLY' }], user: 'Joe', character: avatar },
    };
    return db;
}

test('legacy profile migrates idempotently with exact fixed content and enabled state', () => {
    const config = migrateConfig(legacy);
    assert.equal(config.profiles['Ava.png'].instruction, JOURNAL_INSTRUCTION);
    assert.equal(config.profiles['Ava.png'].readBackTemplate, READ_BACK);
    assert.equal(config.profiles['Ava.png'].telegram, true);
    assert.equal(config.profiles['Ava.png'].enabled, true);
    assert.deepEqual(migrateConfig(config), config);
    assert.deepEqual(legacy, { avatar: 'Ava.png', enabled: true, timezone: 'Europe/London', telegram: true, sceneHold: false });
});

test('new characters start off with their own writing template and independent settings', () => {
    const config = migrateConfig(legacy), eve = characterSettings(config, 'Eve.png', 'Eve March');
    assert.equal(eve.enabled, false); assert.equal(eve.telegram, false);
    assert.equal(eve.instruction, CHARACTER_JOURNAL_INSTRUCTION);
    assert.equal(eve.readBackTemplate, CHARACTER_READ_BACK);
    eve.enabled = true; eve.sceneHold = true; eve.timezone = 'America/New_York'; eve.instruction = 'Eve custom instruction';
    const next = updateCharacterConfig(config, eve);
    assert.deepEqual(next.profiles['Ava.png'], config.profiles['Ava.png']);
    assert.equal(characterSettings(next, 'Marnie.png').instruction, CHARACTER_JOURNAL_INSTRUCTION);
    assert.equal(config.profiles['Eve.png'], undefined);
});

test('each enabled character gets its own daily job and completion does not block others', () => {
    const config = profiles(), db = dbFor(config), completed = [];
    for (let i = 0; i < 3; i++) {
        const job = planCharacters(db, config, now);
        assert.ok(job); assert.ok(!completed.includes(job.avatar));
        completed.push(job.avatar); db.entries.push({ avatar: job.avatar, date: job.date });
    }
    assert.equal(completed.length, 3); assert.equal(planCharacters(db, config, now), null);
});

test('hold and disabled flags affect only their own characters; manual targets current chat', () => {
    const config = profiles(), db = dbFor(config);
    config.profiles['Eve.png'].sceneHold = true; config.profiles['Ava.png'].enabled = false;
    assert.equal(planCharacters(db, config, now).avatar, 'Marnie.png');
    const manual = planCharacters(db, config, now, true, { avatar: 'Eve.png', chatId: 'new-chat' });
    assert.equal(manual.avatar, 'Eve.png'); assert.equal(manual.chatId, 'new-chat');
});

test('unusable snapshots cannot block another character’s eligible saved context', () => {
    const config = profiles(), db = dbFor(config);
    delete db.records[recordKey('Ava.png', 'chat', '2026-11-07')].snapshot;
    db.records[recordKey('Eve.png', 'chat', '2026-11-07')].snapshot.connection = 'other-model';
    const job = planCharacters(db, config, now, false, null, snapshot => snapshot?.connection === 'same-model');
    assert.equal(job.avatar, 'Marnie.png');
});

test('read-back is isolated by avatar and only legacy Ava uses the Ava heading', () => {
    const config = profiles(), entries = ['Ava.png', 'Eve.png', 'Marnie.png'].map((avatar, i) => ({
        avatar, name: `ava-log-2026-11-07-${i + 1}.md`, title: avatar + ' title', beat: avatar + ' private thought',
    }));
    for (const avatar of Object.keys(config.profiles)) {
        const s = characterSettings(config, avatar), text = readBack(entries, avatar, s.readBackTemplate, s.name);
        assert.ok(text.includes(avatar + ' private thought'));
        for (const other of Object.keys(config.profiles).filter(a => a !== avatar)) assert.ok(!text.includes(other));
        assert.equal(text.startsWith("AVA'S OWN PAST JOURNAL"), avatar === 'Ava.png');
    }
});

test('journal request uses its owner’s instruction, snapshot and previous entry', () => {
    const config = profiles(), db = dbFor(config), snapshot = db.records[recordKey('Eve.png', 'chat', '2026-11-07')].snapshot;
    const s = characterSettings(config, 'Eve.png'), previous = { avatar: 'Eve.png', title: 'Eve only', body: 'Her own entry', date: '2026-11-06' };
    const messages = journalMessages(snapshot, '2026-11-07', previous, s.instruction);
    const encoded = JSON.stringify(messages);
    assert.ok(encoded.includes('Eve.png ONLY')); assert.ok(encoded.includes('Her own entry'));
    assert.ok(!encoded.includes('rationed sweetness')); assert.ok(!encoded.includes('Ava'));
    assert.throws(() => journalMessages(snapshot, '2026-11-07', { ...previous, avatar: 'Ava.png' }, s.instruction), /different character/);
});

test('observing a character does not prune another character’s timezone-specific records', () => {
    const db = newDatabase(); db.records.other = { avatar: 'Eve.png', date: '2026-11-04' };
    observe(db, { avatar: 'Ava.png', chatId: 'a', messages: [], timezone: 'Europe/London', now, timestamp: Number });
    assert.ok(db.records.other);
});

test('Telegram identifies the journal owner without including the entry', async () => {
    let body;
    await telegramPing({ token: '123:fixture', chatId: '456', name: 'Eve March', fetcher: async (_, options) => {
        body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) };
    } });
    assert.equal(body.text, 'Eve March wrote a journal entry.');
});
