import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JOURNAL_INSTRUCTION, READ_BACK } from '../content.mjs';
import { DEFAULTS, MINUTE, localParts, previousDate, recordKey, newDatabase, plan, observe, newestFirst, parseEntry, readBack, journalMessages, markdown, uploadEntry, registerAttachment, backoff } from '../core.mjs';

const at = s => Date.parse(`2026-11-06T${s}:00Z`);
const settings = { ...DEFAULTS, enabled: true, avatar: 'Ava.png' };
const body = Array.from({ length: 30 }, () => 'I kept the small notebook.').join(' ');
const output = `TITLE: The small quiet notebook\n\n${body}`;
function dbAt(last, count = 8, date = '2026-11-06') {
    const db = newDatabase(); const record = { avatar: 'Ava.png', chatId: 'recorded-chat', date, count, lastExchange: last, retryAt: 0 };
    db.records[recordKey(record.avatar, record.chatId, date)] = record; return db;
}

test('Danny fixed strings match independently stored UTF-8 fixtures byte for byte', async () => {
    assert.deepEqual(Buffer.from(JOURNAL_INSTRUCTION), await readFile(new URL('./fixtures/journal-instruction.txt', import.meta.url)));
    assert.deepEqual(Buffer.from(READ_BACK), await readFile(new URL('./fixtures/read-back.txt', import.meta.url)));
});
test('90 minute trigger uses eight messages and counts no failed attempt as an entry', () => {
    const db = dbAt(at('18:00'));
    assert.equal(plan(db, settings, at('19:29')), null);
    assert.equal(plan(db, settings, at('19:30')).type, 'ninety-minute');
    Object.values(db.records)[0].count = 7;
    assert.equal(plan(db, settings, at('19:30')), null);
});
test('evening second chance uses 30 idle minutes and stops after success', () => {
    const db = dbAt(at('21:00'));
    assert.equal(plan(db, settings, at('21:29')), null);
    assert.equal(plan(db, settings, at('21:30')).type, 'evening');
    db.entries.push({ avatar: 'Ava.png', date: '2026-11-06' });
    assert.equal(plan(db, settings, at('22:30')), null);
});
test('23:30 ignores scene hold, count threshold and idle; no inactive-day writing', () => {
    const db = dbAt(at('23:29'), 1), held = { ...settings, sceneHold: true };
    assert.equal(plan(db, held, at('23:29')), null);
    assert.equal(plan(db, held, at('23:30')).type, 'catch-up');
    Object.values(db.records)[0].count = 0;
    assert.equal(plan(db, held, at('23:30')), null);
});
test('backfill targets recorded chat rather than the open chat', () => {
    const db = dbAt(Date.parse('2026-11-05T22:00Z'), 1, '2026-11-05');
    const job = plan(db, settings, at('10:00'), false, { avatar: 'SomeoneElse.png', chatId: 'unrelated' });
    assert.deepEqual(job, { date: '2026-11-05', avatar: 'Ava.png', chatId: 'recorded-chat', type: 'backfill' });
    assert.equal(plan(db, { ...settings, sceneHold: true }, at('10:00')), null);
});
test('manual bypasses cap, hold, eight-message threshold, retry and enable', () => {
    const db = dbAt(at('12:00'), 1);
    db.entries.push({ avatar: 'Ava.png', date: '2026-11-06' });
    Object.values(db.records)[0].retryAt = at('23:59');
    assert.equal(plan(db, { ...settings, enabled: false, sceneHold: true }, at('12:01'), true, { avatar: 'Ava.png', chatId: 'recorded-chat' }).type, 'manual');
    assert.equal(plan(db, settings, at('12:01'), true, { avatar: 'Other.png', chatId: 'wrong' }), null);
});
test('London midnight and DST use calendar dates rather than subtracting 24 hours', () => {
    assert.equal(localParts(Date.parse('2026-06-01T23:30Z'), 'Europe/London').date, '2026-06-02');
    assert.equal(previousDate('2026-03-30'), '2026-03-29');
    assert.equal(previousDate('2026-11-01'), '2026-10-31');
    assert.equal(localParts(Date.parse('2026-10-25T01:30Z'), 'Europe/London').time, '01:30');
});
test('sort date then numeric suffix, preserving 10 after 2', () => {
    const rows = ['ava-log-2026-11-06-2.md', 'ava-log-2026-11-05-99.md', 'ava-log-2026-11-06-10.md', 'ava-log-2026-11-06.md'].map(name => ({ name }));
    assert.deepEqual(rows.sort(newestFirst).map(x => x.name), ['ava-log-2026-11-06-10.md', 'ava-log-2026-11-06-2.md', 'ava-log-2026-11-06.md', 'ava-log-2026-11-05-99.md']);
});
test('activity counting is idempotent and does not count swipes/regenerations twice', () => {
    const db = newDatabase(), messages = [{ is_user: true, mes: 'hello', send_date: at('12:00') }, { mes: 'hi', send_date: at('12:01'), swipes: ['hi', 'hello'] }, { is_system: true, mes: 'system', send_date: at('12:02') }];
    const args = { avatar: 'Ava.png', chatId: 'chat', messages, timezone: 'Europe/London', now: at('13:00'), timestamp: x => x };
    assert.equal(observe(db, args), true); assert.equal(observe(db, args), false);
    assert.equal(Object.values(db.records)[0].count, 2);
    messages[1].mes = 'new reply'; observe(db, args); assert.equal(Object.values(db.records)[0].count, 2);
});
test('title extracted in same pass; body untouched; malformed or missing title falls back', () => {
    const parsed = parseEntry(output); assert.equal(parsed.title, 'The small quiet notebook'); assert.equal(parsed.body, body); assert.equal(parsed.fallback, false);
    assert.equal(parseEntry(`TITLE: Too short\n\n${body}`).title, 'I kept the small notebook.');
    assert.equal(parseEntry(`TITLE: Three words here!\n\n${body}`).fallback, true);
    assert.equal(parseEntry(body).fallback, true);
    assert.throws(() => parseEntry('TITLE: A very short entry\n\nToo short.'), /expected 150/);
});
test('new messages and edits retain backoff while invalidating stale context', () => {
    const db = newDatabase(), messages = [{ is_user: true, mes: 'first', send_date: at('23:30') }];
    const args = { avatar: 'Ava.png', chatId: 'chat', messages, timezone: 'Europe/London', now: at('23:31'), timestamp: x => x };
    observe(db, args);
    const key = recordKey('Ava.png', 'chat', '2026-11-06');
    backoff(db.records[key], at('23:31'));
    db.records[key].snapshot = { messages: ['stale'] };
    messages.push({ mes: 'new reply', send_date: at('23:31') });
    observe(db, args);
    assert.equal(db.records[key].failures, 1);
    assert.equal(db.records[key].retryAt, at('23:33'));
    assert.equal(db.records[key].snapshot, undefined);
    assert.equal(plan(db, settings, at('23:32')), null);
    assert.equal(plan(db, settings, at('23:33')).type, 'catch-up');
    messages[1].mes = 'edited reply'; observe(db, args);
    assert.equal(db.records[key].failures, 1);
    assert.equal(db.records[key].retryAt, at('23:33'));
});
test('read-back contains only three titles and latest closing beat with literal substitution', () => {
    const entries = [1,2,3,4].map(n => ({ avatar: 'Ava.png', name: `ava-log-2026-11-06-${n}.md`, title: `Title ${n}`, beat: '$& is literal.' }));
    const text = readBack(entries, 'Ava.png'); assert.ok(!text.includes('Title 1')); assert.ok(text.includes('Title 4 | Title 3 | Title 2')); assert.ok(text.endsWith('$& is literal.'));
    assert.equal(readBack(entries, 'Other.png'), '');
});
test('previous full entry and target date are data; trailing instruction is user-role', () => {
    const snapshot = { messages: [{ role: 'system', content: 'Original card' }], user: 'Joe', timezone: 'Europe/London' };
    const messages = journalMessages(snapshot, '2026-11-05', { date: '2026-11-04', title: 'Previous entry title', body });
    assert.equal(messages.at(-1).role, 'user'); assert.equal(messages.at(-1).content, JOURNAL_INSTRUCTION.replaceAll('{{user}}', 'Joe'));
    assert.equal(JSON.parse(messages.at(-2).content).previous_journal.body, body);
    assert.equal(snapshot.messages.length, 1);
});
test('Markdown frontmatter escapes generated title and preserves journal date for backfill', () => {
    const text = markdown({ date: '2026-11-05', title: 'A "quoted" title', body, avatar: 'Ava.png', chatId: 'c' }, at('10:00'), 'Europe/London');
    assert.match(text, /date: 2026-11-05/); assert.match(text, /written_at: "2026-11-06/); assert.match(text, /title: "A \\"quoted\\" title"/);
});
test('collision suffix increments without overwriting and uncertain uploads recover exact bytes', async () => {
    const files = new Map([['/user/files/ava-log-2026-11-06.md', 'old'], ['/user/files/ava-log-2026-11-06-2.md', 'also old']]); let remembered;
    const ops = { verify: async url => files.has(url), read: async url => files.get(url), upload: async (name, text) => { assert.ok(!files.has(`/user/files/${name}`)); files.set(`/user/files/${name}`, text); return `/user/files/${name}`; }, remember: async e => { remembered = e; }, guard: () => {} };
    const saved = await uploadEntry({ entry: { date: '2026-11-06' }, text: 'new', ...ops });
    assert.equal(saved.name, 'ava-log-2026-11-06-3.md'); assert.equal(files.get('/user/files/ava-log-2026-11-06.md'), 'old');
    const recovered = await uploadEntry({ entry: remembered, text: 'new', ...ops, upload: async () => { throw Error('must not upload twice'); } }); assert.equal(recovered.name, saved.name);
});
test('Data Bank registration protects file but disables retrieval without changing card', () => {
    const settings = { character_attachments: {}, disabled_attachments: [] }, entry = { avatar: 'Ava.png', url: '/user/files/ava-log-2026-11-06.md', name: 'ava-log-2026-11-06.md' };
    registerAttachment(settings, entry, 200, 1); registerAttachment(settings, entry, 200, 1);
    assert.equal(settings.character_attachments['Ava.png'].length, 1); assert.deepEqual(settings.disabled_attachments, [entry.url]);
});
