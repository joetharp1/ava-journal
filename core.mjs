import { JOURNAL_INSTRUCTION, READ_BACK, CHARACTER_JOURNAL_INSTRUCTION, CHARACTER_READ_BACK } from './content.mjs';

export const NAME = 'ava-journal';
export const FILE_PREFIX = '/user/files/';
export const MINUTE = 60_000;
export const DEFAULTS = Object.freeze({ enabled: false, avatar: '', timezone: 'Europe/London', sceneHold: false, telegram: false });
export const clone = value => structuredClone(value);
export function migrateConfig(value = {}) {
    if (value?.version === 2 && value.profiles) return clone(value);
    const config = { version: 2, profiles: {} };
    if (value?.avatar) config.profiles[value.avatar] = { ...DEFAULTS, ...clone(value), instruction: JOURNAL_INSTRUCTION, readBackTemplate: READ_BACK };
    return config;
}
export function characterSettings(config, avatar, name = '') {
    return { ...DEFAULTS, instruction: CHARACTER_JOURNAL_INSTRUCTION, readBackTemplate: CHARACTER_READ_BACK,
        ...clone(config.profiles?.[avatar] || {}), avatar, name: name || config.profiles?.[avatar]?.name || avatar.replace(/\.png$/i, '') };
}
export function updateCharacterConfig(config, settings) {
    if (!settings.avatar) throw new Error('Open a character chat first.');
    const next = migrateConfig(config);
    next.profiles[settings.avatar] = clone(settings);
    return next;
}
export function planCharacters(db, config, now, manual = false, active = null, usable = () => true) {
    if (manual) return active ? plan(db, characterSettings(config, active.avatar), now, true, active) : null;
    return Object.keys(config.profiles).map(avatar => plan(db, characterSettings(config, avatar), now, false, active))
        .filter(job => job && usable(db.records[recordKey(job.avatar, job.chatId, job.date)]?.snapshot, job))
        .sort((a, b) => a.date.localeCompare(b.date)
            || (db.records[recordKey(a.avatar, a.chatId, a.date)]?.lastExchange || 0) - (db.records[recordKey(b.avatar, b.chatId, b.date)]?.lastExchange || 0))[0] || null;
}
export function localParts(now, timezone) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, time: `${p.hour}:${p.minute}` };
}
export function previousDate(date) {
    const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10);
}
export function recordKey(avatar, chatId, date) { return JSON.stringify([avatar, chatId, date]); }
export function newDatabase() { return { version: 1, records: {}, entries: [], pending: null }; }
export function entryParts(name) {
    const match = /^ava-log-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/.exec(name);
    return match ? { date: match[1], sequence: Number(match[2] || 1) } : null;
}
export function newestFirst(a, b) {
    const aa = entryParts(a.name), bb = entryParts(b.name);
    return (bb?.date || '').localeCompare(aa?.date || '') || (bb?.sequence || 0) - (aa?.sequence || 0);
}
export function hasEntry(db, avatar, date) { return db.entries.some(e => e.avatar === avatar && e.date === date); }
export function plan(db, settings, now, manual = false, active = null) {
    const today = localParts(now, settings.timezone), yesterday = previousDate(today.date);
    const records = Object.values(db.records).filter(r => r.avatar === settings.avatar);
    if (manual) {
        if (!active || active.avatar !== settings.avatar) return null;
        return { date: today.date, avatar: active.avatar, chatId: active.chatId, type: 'manual' };
    }
    if (!settings.enabled) return null;
    // Most recently active recorded chat owns a day's single automatic entry.
    const latest = date => records.filter(r => r.date === date && r.count > 0).sort((a, b) => b.lastExchange - a.lastExchange)[0];
    const due = (r, type) => r && r.retryAt <= now ? { date: r.date, avatar: r.avatar, chatId: r.chatId, type } : null;
    const current = latest(today.date);
    if (current && !hasEntry(db, settings.avatar, today.date)) {
        if (today.minutes >= 23 * 60 + 30) return due(current, 'catch-up');
        if (!settings.sceneHold && current.count >= 8) {
            const idle = now - current.lastExchange;
            if (idle >= 90 * MINUTE) return due(current, 'ninety-minute');
            // A failed/blocked 90-minute attempt is not a completed journal.
            if (today.minutes >= 21 * 60 && idle >= 30 * MINUTE) return due(current, 'evening');
        }
    }
    if (!settings.sceneHold && !hasEntry(db, settings.avatar, yesterday)) return due(latest(yesterday), 'backfill');
    return null;
}
export function observe(db, { avatar, chatId, messages, timezone, now, timestamp }) {
    const today = localParts(now, timezone).date, yesterday = previousDate(today);
    const grouped = new Map();
    messages.forEach((m, i) => {
        if (m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) return;
        const at = timestamp(m.send_date);
        if (!Number.isFinite(at) || at > now + MINUTE) return;
        const date = localParts(at, timezone).date;
        if (date !== today && date !== yesterday) return;
        if (!grouped.has(date)) grouped.set(date, []);
        grouped.get(date).push({ i, at, text: m.mes, user: !!m.is_user });
    });
    let changed = false;
    for (const [date, items] of grouped) {
        const key = recordKey(avatar, chatId, date), old = db.records[key];
        // Count actual transcript positions, not generation attempts or swipes.
        const signature = JSON.stringify(items.map(x => [x.i, x.at, x.user, x.text]));
        if (old?.signature === signature) continue;
        db.records[key] = { ...old, avatar, chatId, date, count: items.length, lastExchange: Math.max(...items.map(x => x.at)), signature, retryAt: old?.retryAt ?? 0, failures: old?.failures ?? 0 };
        // Never reuse an older context snapshot after a message edit/deletion.
        delete db.records[key].snapshot;
        changed = true;
    }
    for (const [key, r] of Object.entries(db.records)) {
        if (r.avatar === avatar && r.date < yesterday) { delete db.records[key]; changed = true; }
    }
    return changed;
}
export class JournalWordCountError extends Error {
    constructor(count) {
        super(`Journal returned ${count} words; expected 150–250. Nothing saved.`);
        this.name = 'JournalWordCountError';
    }
}
export function parseEntry(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/^```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
    const lines = text.split(/\r?\n/);
    let title = '', fallback = false;
    if (/^TITLE\s*:/i.test(lines[0] || '')) title = lines.shift().replace(/^TITLE\s*:\s*/i, '').trim();
    const body = lines.join('\n').trim();
    const words = body.match(/\S+/g) || [];
    if (words.length < 150 || words.length > 250) throw new JournalWordCountError(words.length);
    const titleWords = title.match(/\S+/g) || [];
    if (titleWords.length < 3 || titleWords.length > 6 || /[^\p{L}\p{N}\s]/u.test(title)) {
        title = words.slice(0, 5).join(' '); fallback = true;
    }
    const sentences = body.match(/[^.!?]+(?:[.!?]+["'”’]?|$)/g)?.map(x => x.trim()).filter(Boolean) || [];
    const beat = sentences.slice(-2).join(' ');
    if (!beat || beat.length > 900) throw new Error('Journal closing beat is too long for the read-back budget. Nothing saved.');
    return { title, body, beat, fallback };
}
export function readBack(entries, avatar, template = READ_BACK, name = '') {
    const recent = entries.filter(e => e.avatar === avatar).sort(newestFirst).slice(0, 3);
    if (!recent.length) return '';
    // Substitution callbacks prevent $&, $', etc. in model text being interpreted.
    return template.replaceAll('{{char}}', () => name || avatar.replace(/\.png$/i, '')).replace('[titles]', () => recent.map(e => e.title).join(' | ')).replace('[beat]', () => recent[0].beat);
}
export function journalMessages(snapshot, date, previous, instruction = JOURNAL_INSTRUCTION) {
    if (!snapshot || !Array.isArray(snapshot.messages) || !snapshot.messages.length) throw new Error('The recorded conversation has no saved context yet. Open that character’s chat once to prepare it.');
    if (previous && previous.avatar !== snapshot.avatar) throw new Error('Previous journal belongs to a different character.');
    const messages = clone(snapshot.messages);
    // These JSON keys are data labels, not additional authored instructions.
    messages.push({ role: 'system', content: JSON.stringify({ journal_date: date, timezone: snapshot.timezone, previous_journal: previous ? { date: previous.date, title: previous.title, body: previous.body } : null }) });
    messages.push({ role: 'user', content: instruction.replaceAll('{{user}}', () => snapshot.user).replaceAll('{{char}}', () => snapshot.character) });
    return messages;
}
export function markdown(entry, now, timezone) {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).format(new Date(now));
    return `---\ndate: ${entry.date}\ntime: ${JSON.stringify(time)}\ntimezone: ${JSON.stringify(timezone)}\ntitle: ${JSON.stringify(entry.title)}\navatar: ${JSON.stringify(entry.avatar)}\nchat_id: ${JSON.stringify(entry.chatId)}\nwritten_at: ${JSON.stringify(new Date(now).toISOString())}\n---\n\n${entry.body}\n`;
}
export function registerAttachment(settings, entry, size, now) {
    settings.character_attachments ||= {};
    settings.character_attachments[entry.avatar] ||= [];
    settings.disabled_attachments ||= [];
    const attachments = settings.character_attachments[entry.avatar];
    if (!attachments.some(a => a.url === entry.url)) attachments.push({ url: entry.url, name: entry.name, size, created: now });
    if (!settings.disabled_attachments.includes(entry.url)) settings.disabled_attachments.push(entry.url);
}
export function backoff(record, now) {
    record.failures = (record.failures || 0) + 1;
    record.retryAt = now + Math.min(30, 2 ** Math.min(record.failures, 5)) * MINUTE;
}

export async function uploadEntry({ entry, text, verify, upload, read, remember, guard }) {
    let sequence = entry.name ? entryParts(entry.name)?.sequence : 1;
    if (!sequence) throw new Error('Invalid journal filename.');
    while (sequence <= 10000) {
        guard();
        const name = `ava-log-${entry.date}${sequence === 1 ? '' : `-${sequence}`}.md`, url = `${FILE_PREFIX}${name}`;
        const exists = await verify(url);
        guard();
        if (exists) {
            // Only recover a file whose attempted name was durably recorded before upload.
            if (entry.name === name && await read(url) === text) return { ...entry, name, url };
            sequence++; continue;
        }
        entry = { ...entry, name, url };
        await remember(entry);
        guard();
        const returned = await upload(name, text);
        if (returned !== url) throw new Error('ST returned an unexpected journal file path.');
        return entry;
    }
    throw new Error('Too many journal filename collisions. Nothing overwritten.');
}
