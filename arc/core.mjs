// Ava's fictional story calendar. No medical prediction and no model-authored clock.
export const VERSION = 1;
export const DAY_MS = 86400000;
export const BIRTH_CURVE = Object.freeze([5, 7, 10, 13, 17, 22, 28, 35, 43, 52, 62, 72, 82, 92, 100]);
export const STAGES = Object.freeze({
    pregnancy: Object.freeze({ implantation: 0, 'trimester-one': 14, 'trimester-two-opening': 42, 'trimester-two-late': 98, 'trimester-three': 182, term: 266 }),
    postpartum: Object.freeze({ heavy: 0, recovering: 14, settling: 42 }),
});
export class ArcError extends Error {
    constructor(message, code = 'INVALID', status = 400) { super(message); this.code = code; this.status = status; }
}
const check = (ok, message) => { if (!ok) throw new ArcError(message); };
export function dayIndex(date) {
    check(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date), 'Invalid calendar date.');
    const time = Date.parse(`${date}T00:00:00Z`);
    check(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date, 'Invalid calendar date.');
    return time / DAY_MS;
}
export const addDays = (date, days) => {
    check(Number.isSafeInteger(days), 'Invalid date offset.');
    return new Date((dayIndex(date) + days) * DAY_MS).toISOString().slice(0, 10);
};
export const daysBetween = (start, end) => dayIndex(end) - dayIndex(start);
export function dateInZone(now, timezone) {
    check(Number.isFinite(Number(now)), 'Invalid request time.');
    let parts;
    try { parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)); }
    catch { throw new ArcError('Invalid timezone.'); }
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}
export function createRecord({ avatar, timezone = 'Europe/London', arcType = 'cycle', startDate, id, today }) {
    check(typeof avatar === 'string' && avatar.length > 0 && avatar.length <= 256, 'Bind Ava by her exact avatar ID.');
    check(typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id), 'Invalid arc identity.');
    check(['cycle', 'pregnancy', 'postpartum'].includes(arcType), 'Invalid arc type.');
    dateInZone(Date.now(), timezone); dayIndex(startDate); dayIndex(today);
    check(startDate <= today, 'The start date cannot be in the future.');
    return { version: VERSION, avatar, timezone, arcId: id, arcType, arcStartDate: startDate,
        conceptionDate: arcType === 'pregnancy' ? startDate : null,
        birthDate: arcType === 'postpartum' ? startDate : null, override: null, bellyOverride: null,
        encounterHighWater: 0, encounters: [], daily: {} };
}
export function validateRecord(r) {
    check(r?.version === VERSION && typeof r.avatar === 'string' && !!r.avatar && typeof r.arcId === 'string', 'Invalid calendar record.');
    check(['cycle', 'pregnancy', 'postpartum'].includes(r.arcType), 'Invalid stored arc type.');
    dayIndex(r.arcStartDate); dateInZone(Date.now(), r.timezone);
    if (r.conceptionDate !== null) dayIndex(r.conceptionDate);
    if (r.birthDate !== null) dayIndex(r.birthDate);
    check(Array.isArray(r.encounters) && r.encounters.length <= 50 && Number.isSafeInteger(r.encounterHighWater) && r.encounterHighWater >= 0, 'Invalid encounter ledger.');
    check(r.daily && typeof r.daily === 'object' && !Array.isArray(r.daily), 'Invalid daily ledger.');
    if (r.override) {
        const o = r.override;
        check(['day', 'stage', 'birth'].includes(o.kind) && typeof o.arcId === 'string' && ['cycle', 'pregnancy', 'postpartum'].includes(o.arcType), 'Invalid override.');
        dayIndex(o.anchorDate);
        check(Number.isSafeInteger(o.dayAtAnchor) && o.dayAtAnchor >= (o.arcType === 'cycle' ? 1 : 0), 'Invalid override day.');
    }
    if (r.bellyOverride) check(BELLIES.includes(r.bellyOverride.value) && typeof r.bellyOverride.arcId === 'string', 'Invalid belly override.');
    return r;
}
export const BELLIES = Object.freeze(['flat', 'bloat', 'soft swell', 'visible', 'definite', 'heavy', 'engaged', 'postpartum-soft']);
export function effectiveAnchor(record) {
    validateRecord(record);
    const o = record.override;
    if (o && o.arcId === record.arcId && o.arcType === record.arcType) {
        return addDays(o.anchorDate, -(o.dayAtAnchor - (record.arcType === 'cycle' ? 1 : 0)));
    }
    return record.arcStartDate;
}
export function dailySeed(avatar, date) {
    dayIndex(date);
    let h = 2166136261;
    for (const n of new TextEncoder().encode(JSON.stringify([avatar, date]))) h = Math.imul(h ^ n, 16777619) >>> 0;
    return h;
}
export function derive(record, today) {
    if (!record) return null;
    dayIndex(today);
    const anchor = effectiveAnchor(record), elapsed = daysBetween(anchor, today);
    check(elapsed >= 0, 'Calendar precedes its effective anchor.');
    let arcType = record.arcType, day = elapsed, cycleStartDate = null;
    const dates = { conceptionDate: record.conceptionDate, birthDate: record.birthDate, effectiveStartDate: anchor };
    // Pure projection makes a missed day-84 hand-off correct even without a timer.
    // normalizeRecord persists the hand-off on the next transaction.
    if (arcType === 'postpartum' && elapsed >= 84) { arcType = 'cycle'; day = elapsed - 84; }
    if (arcType === 'cycle') {
        const base = record.arcType === 'postpartum' ? addDays(anchor, 84) : anchor;
        day = (day % 28) + 1;
        cycleStartDate = addDays(today, -(day - 1));
        return { ...dates, date: today, timezone: record.timezone, arcType, day, stage: 'cycle', cycleStartDate,
            bleeding: day <= 5, fertile: day >= 10 && day <= 16, peak: day >= 13 && day <= 15,
            belly: null, symptoms: [], symptomSeed: dailySeed(record.avatar, today), overrideActive: !!record.override && record.override.arcId === record.arcId && record.override.arcType === arcType };
    }
    let stage, belly, pool = [], easing = false;
    if (arcType === 'postpartum') {
        stage = day < 14 ? 'heavy' : day < 42 ? 'recovering' : 'settling';
        belly = 'postpartum-soft'; pool = ['lochia', 'afterpains', 'feeding', 'exhaustion'];
    } else {
        stage = day < 14 ? 'implantation' : day < 42 ? 'trimester-one' : day < 98 ? 'trimester-two-opening' : day < 182 ? 'trimester-two-late' : day < 266 ? 'trimester-three' : 'term';
        belly = day <= 41 ? 'flat' : day <= 55 ? 'bloat' : day <= 83 ? 'soft swell' : day <= 139 ? 'visible' : day <= 181 ? 'definite' : day <= 265 ? 'heavy' : 'engaged';
        if (day >= 8 && day <= 13) pool = ['twinge', 'fatigue'];
        if (day >= 14 && day <= 97) { pool = ['nausea', 'breast tenderness', 'fatigue', 'smell sensitivity', 'food aversion', 'hunger that turns fast']; easing = day >= 70; }
        if (day >= 98 && day <= 181) pool = ['back ache', 'heartburn', 'appetite', 'short temper'];
        if (day >= 182 && day <= 265) pool = ['breathlessness', 'swelling', 'broken sleep', ...(day >= 210 ? ['Braxton Hicks'] : [])];
        if (day >= 266) pool = ['restlessness', 'pressure', 'dropping'];
    }
    if (record.bellyOverride?.arcId === record.arcId) belly = record.bellyOverride.value;
    const seed = dailySeed(record.avatar, today);
    // One deterministic cue, not a diagnosis. Easing is explicit; do not invent severity.
    const symptoms = pool.length ? [pool[seed % pool.length]] : [];
    return { ...dates, date: today, timezone: record.timezone, arcType, day, stage, belly, symptoms, symptomsEasing: easing,
        symptomSeed: seed, fertile: false, overrideActive: !!record.override && record.override.arcId === record.arcId };
}
export function pruneEncounters(record, today) {
    record.encounters = record.encounters.filter(e => daysBetween(e.date, today) < 30).sort((a, b) => a.sequence - b.sequence).slice(-50);
}
export function normalizeRecord(record, today) {
    validateRecord(record);
    pruneEncounters(record, today);
    if (record.arcType === 'postpartum') {
        const anchor = effectiveAnchor(record);
        if (daysBetween(anchor, today) >= 84) {
            record.arcType = 'cycle'; record.arcStartDate = addDays(anchor, 84);
            record.arcId += '-cycle';
            // Preserve Joe's override as history; it remains bound to the earlier arc.
        }
    }
    return record;
}
export function birthTransition(record, date, cause) {
    dayIndex(date);
    check(record.arcType === 'pregnancy', 'Birth requires an active pregnancy arc.');
    record.birthDate = date; record.arcType = 'postpartum'; record.arcStartDate = date;
    record.arcId += '-birth';
    record.lastTransition = { type: 'birth', date, cause };
}
export function setOverride(record, change, today) {
    validateRecord(record); dayIndex(today);
    check(change && ['day', 'stage'].includes(change.kind), 'Override must set a day or stage.');
    if (change.kind === 'stage' && change.value === 'birth') {
        birthTransition(record, today, 'manual-override');
        record.override = { kind: 'birth', value: 'birth', arcId: record.arcId, arcType: 'postpartum', anchorDate: today, dayAtAnchor: 0, stageStartDay: 0 };
        return record;
    }
    let day = change.value;
    if (change.kind === 'stage') {
        day = STAGES[record.arcType]?.[change.value];
        check(day !== undefined, 'Stage is not valid for the current arc.');
    }
    check(Number.isSafeInteger(day) && day >= (record.arcType === 'cycle' ? 1 : 0), 'Invalid day override.');
    if (record.arcType === 'cycle') check(day <= 28, 'Cycle override must be day 1–28.');
    if (record.arcType === 'postpartum') check(day <= 83, 'Postpartum override must be day 0–83.');
    record.override = { kind: change.kind, value: change.value, arcId: record.arcId, arcType: record.arcType, anchorDate: today, dayAtAnchor: day,
        ...(change.kind === 'stage' ? { stageStartDay: day } : {}) };
    return record;
}
export function eligible(record, date, encounter) {
    const state = derive(record, date);
    return state.arcType === 'cycle' && state.fertile && encounter.unprotected === true && encounter.penetrative === true && encounter.internalCompletion === true;
}
// Trusted coordinator API, deliberately NOT registered as a model tool or HTTP route.
// Sequence is assigned once to a canonical encounter, never by the model. A pruned
// old sequence is rejected, preventing a replay from becoming a fresh roll.
export function recordEncounter(record, event, today, decide) {
    normalizeRecord(record, today);
    check(typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 200 && Number.isSafeInteger(event.sequence) && event.sequence > 0, 'Invalid encounter identity.');
    dayIndex(event.date);
    const old = record.encounters.find(e => e.id === event.id || e.sequence === event.sequence);
    if (old) {
        check(old.id === event.id && old.sequence === event.sequence && old.date === event.date, 'Encounter identity conflict.');
        return { duplicate: true, receipt: structuredClone(old) };
    }
    if (event.sequence <= record.encounterHighWater || daysBetween(event.date, today) >= 30) throw new ArcError('Encounter is expired or already processed; no new roll.', 'EXPIRED', 409);
    check(event.date === today, 'New encounters must be recorded on their actual local date.');
    if (!eligible(record, event.date, event)) return { eligible: false };
    const state = derive(record, event.date), probability = state.peak ? 25 : 18;
    const outcome = decide(probability);
    check(typeof outcome === 'boolean', 'Encounter decision must be boolean.');
    const receipt = { id: event.id, sequence: event.sequence, date: event.date, probability, success: outcome };
    record.encounters.push(receipt); record.encounterHighWater = event.sequence;
    if (outcome) {
        record.arcType = 'pregnancy'; record.conceptionDate = event.date; record.arcStartDate = event.date;
        record.arcId += '-conception';
    }
    pruneEncounters(record, today);
    return { eligible: true, duplicate: false, receipt: structuredClone(receipt) };
}
// Foundation for future daily decisions. Transition and receipt commit together.
export function recordDaily(record, { date, kind, arcId }, decide) {
    dayIndex(date);
    check(kind === 'birth' && typeof arcId === 'string', 'Unsupported daily event.');
    const key = JSON.stringify([arcId, kind, date]);
    if (Object.hasOwn(record.daily, key)) return { duplicate: true, receipt: structuredClone(record.daily[key]) };
    check(record.arcId === arcId && record.arcType === 'pregnancy', 'Daily event does not match the current arc.');
    const state = derive(record, date);
    check(state.day >= 273, 'Birth window has not opened.');
    const result = state.day >= 287 ? true : decide(state);
    check(typeof result === 'boolean', 'Daily decision must be boolean.');
    const receipt = { date, kind, arcId, success: result };
    record.daily[key] = receipt;
    if (result) birthTransition(record, date, 'daily-event');
    return { duplicate: false, receipt: structuredClone(receipt) };
}
export function catchUpDates(startDate, throughDate) {
    const count = daysBetween(startDate, throughDate) + 1;
    if (count <= 0) return { dates: [], nextDate: null };
    const length = Math.min(count, 60);
    return { dates: Array.from({ length }, (_, i) => addDays(startDate, i)), nextDate: count > 60 ? addDays(startDate, 60) : null };
}
export const BLOCK_START = '[AVA_ARC_STATE_V1]';
export const BLOCK_END = '[/AVA_ARC_STATE_V1]';
export function withoutArcBlocks(messages) {
    return messages.filter(m => !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(BLOCK_START + '\n') && m.content.endsWith('\n' + BLOCK_END)));
}
export function injectState(messages, state) {
    check(Array.isArray(messages), 'Calendar requires a message array.');
    const clean = withoutArcBlocks(messages);
    if (state) clean.push({ role: 'system', content: `${BLOCK_START}\n${JSON.stringify(state)}\n${BLOCK_END}` });
    return clean;
}
