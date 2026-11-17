import { randomUUID } from 'node:crypto';
import { createFileStore } from './server-store.mjs';
import { ArcError, createRecord, dateInZone, normalizeRecord, derive, setOverride, BELLIES } from './core.mjs';
import { advanceCalendar, beginEncounter, appendEncounter, encounterView, rollPercent } from './coordinator.mjs';

export const info = { id: 'ava-calendar', name: 'Ava Calendar', description: 'Opt-in Ava calendar with persistent events and local-date catch-up.' };
export function registerRoutes(router, { store = createFileStore(), now = Date.now, id = randomUUID, decide = rollPercent } = {}) {
    const wrap = action => (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const root = req.user?.directories?.root;
            if (!req.user?.profile?.handle || !root) throw new ArcError('Authenticated user required.', 'AUTH', 401);
            const b = req.body;
            if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.avatar !== 'string' || b.avatar.length > 256) throw new ArcError('Character identity required.');
            return res.json(action(root, b));
        } catch (error) {
            return res.status(error.status || 500).json({ error: error instanceof ArcError ? error.message : 'Calendar storage failed; no model request should proceed.', code: error.code || 'STORAGE' });
        }
    };
    const owned = (envelope, avatar) => {
        if (!envelope.record || envelope.record.avatar !== avatar) throw new ArcError('This character has no configured calendar.', 'NOT_CONFIGURED', 404);
        return envelope.record;
    };
    const reply = envelope => ({ revision: envelope.revision, record: envelope.record,
        encounter: envelope.record ? encounterView(envelope.record, dateInZone(now(), envelope.record.timezone)) : null,
        state: envelope.record ? derive(envelope.record, dateInZone(now(), envelope.record.timezone)) : null });
    router.post('/state', wrap((root, b) => {
        const initial = store.read(root);
        // A different character is completely inert: no normalization or writes.
        if (!initial.record || initial.record.avatar !== b.avatar) return { revision: 0, state: null };
        const envelope = store.transaction(root, e => advanceCalendar(e.record, dateInZone(now(), e.record.timezone), decide));
        const { record, ...result } = reply(envelope);
        return result;
    }));
    router.post('/inspect', wrap((root, b) => reply(store.transaction(root, e => {
        const r = owned(e, b.avatar); advanceCalendar(r, dateInZone(now(), r.timezone), decide);
    }))));
    router.post('/configure', wrap((root, b) => {
        if (b.confirmAva !== true || b.expectedRevision !== 0) throw new ArcError('Explicit Ava binding and initial revision required.');
        return reply(store.transaction(root, e => {
            if (e.record) throw new ArcError('Ava is already bound; nothing replaced.', 'CONFLICT', 409);
            e.record = createRecord({ avatar: b.avatar, timezone: b.timezone, arcType: b.arcType,
                startDate: b.startDate, today: dateInZone(now(), b.timezone || 'Europe/London'), id: id() });
        }, 0));
    }));
    for (const operation of ['override', 'clear-override', 'belly']) router.post('/' + operation, wrap((root, b) => {
        if (!Number.isSafeInteger(b.expectedRevision)) throw new ArcError('Expected revision required.');
        return reply(store.transaction(root, e => {
            const r = owned(e, b.avatar), today = dateInZone(now(), r.timezone);
            normalizeRecord(r, today);
            if (operation === 'override') setOverride(r, b.change, today);
            if (operation === 'clear-override') { r.override = null; r.bellyOverride = null; }
            if (operation === 'belly') {
                if (!BELLIES.includes(b.value)) throw new ArcError('Unknown belly state.');
                r.bellyOverride = { arcId: r.arcId, value: b.value, anchorDate: today };
            }
            advanceCalendar(r, today, decide);
        }, b.expectedRevision));
    }));
    router.post('/begin-encounter', wrap((root, b) => {
        if (!Number.isSafeInteger(b.expectedRevision)) throw new ArcError('Expected revision required.');
        return reply(store.transaction(root, e => {
            const r = owned(e, b.avatar), today = dateInZone(now(), r.timezone);
            advanceCalendar(r, today, decide); beginEncounter(r, b, today, id);
        }, b.expectedRevision));
    }));
    router.post('/append-event', wrap((root, b) => {
        if (b.event !== 'completed_encounter') throw new ArcError('Unsupported calendar event.');
        const e = store.transaction(root, e => {
            const r = owned(e, b.avatar), today = dateInZone(now(), r.timezone);
            advanceCalendar(r, today, decide);
            return appendEncounter(r, b, today, decide);
        });
        return { ...reply(e), result: e.result };
    }));
}
export async function init(router) { registerRoutes(router); }
