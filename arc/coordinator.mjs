import { randomInt, randomUUID } from 'node:crypto';
import { ArcError, BIRTH_CURVE, addDays, effectiveAnchor, derive, normalizeRecord, catchUpDates, recordDaily, recordEncounter, birthTransition } from './core.mjs';

export const rollPercent = percent => randomInt(1000000) < percent * 10000;

// Called inside the file transaction: receipt, cursor and transition commit together.
export function advanceCalendar(record, today, decide = rollPercent) {
    if (record.arcType === 'pregnancy') {
        const anchor = effectiveAnchor(record);
        const override = record.override?.arcId === record.arcId ? record.override : null;
        // A manual jump takes effect today; it cannot manufacture earlier births.
        const start = [addDays(anchor, 273), override?.anchorDate || '0000-01-01'].sort().at(-1);
        const clock = JSON.stringify([record.arcId, anchor, override]);
        const saved = record.birthCursor?.clock === clock ? record.birthCursor.nextDate : null;
        const from = saved && saved > start ? saved : start;
        const batch = catchUpDates(from, today);
        for (const date of batch.dates) {
            const arcId = record.arcId;
            const prior = record.daily[JSON.stringify([arcId, 'birth', date])];
            if (prior && !prior.success && derive(record, date).day >= 287) {
                // A same-day manual jump can move an already failed roll to the
                // forced deadline. Preserve that roll; record the forced transition.
                birthTransition(record, date, 'forced-day-287');
                record.birthCursor = { clock, nextDate: addDays(date, 1) };
                break;
            }
            const result = recordDaily(record, { date, kind: 'birth', arcId }, state => decide(BIRTH_CURVE[Math.min(state.day, 287) - 273]));
            record.birthCursor = { clock, nextDate: addDays(date, 1) };
            if (result.receipt.success) break;
        }
        if (record.arcType === 'pregnancy' && batch.nextDate) throw new ArcError('Calendar catch-up is incomplete.', 'CATCH_UP', 503);
    }
    normalizeRecord(record, today);
    return derive(record, today);
}

export function beginEncounter(record, { chatId }, today, id = randomUUID) {
    const state = derive(record, today);
    if (record.arcType !== 'cycle' || !state.fertile) throw new ArcError('An encounter can be opened only on cycle days 10–16.');
    if (typeof chatId !== 'string' || !chatId || chatId.length > 300) throw new ArcError('Open Ava’s one-to-one chat first.');
    // Only Joe's control opens a new identity. The model cannot create one.
    const sequence = Math.max(record.encounterIssued || 0, record.encounterHighWater) + 1;
    record.encounterIssued = sequence;
    record.activeEncounter = { id: id(), sequence, date: today, chatId, arcId: record.arcId };
    return record.activeEncounter;
}

export function appendEncounter(record, body, today, decide = rollPercent) {
    const pending = record.activeEncounter;
    if (!pending || body.encounterId !== pending.id || body.chatId !== pending.chatId)
        throw new ArcError('Encounter changed or is not open. Refresh the calendar.', 'ENCOUNTER', 409);
    const facts = body.facts;
    const keys = ['unprotected', 'penetrative', 'internalCompletion'];
    if (!facts || Object.keys(facts).length !== 3 || keys.some(k => typeof facts[k] !== 'boolean')) throw new ArcError('Three explicit encounter facts are required.');
    const receipt = record.encounters.find(e => e.id === pending.id);
    if (!receipt && (pending.date !== today || pending.arcId !== record.arcId)) throw new ArcError('This encounter has expired; no roll.', 'EXPIRED', 409);
    return recordEncounter(record, { ...pending, ...facts }, today, decide);
}

export function encounterView(record, today) {
    const event = record.activeEncounter;
    if (!event) return null;
    const receipt = record.encounters.find(e => e.id === event.id);
    return { ...event, receipt: receipt || null,
        open: !receipt && event.date === today && event.arcId === record.arcId && record.arcType === 'cycle' && derive(record, today).fertile };
}
