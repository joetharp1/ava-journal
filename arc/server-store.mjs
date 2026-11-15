import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ArcError, validateRecord } from './core.mjs';

// One SillyTavern Node process owns this store. Entire transactions are synchronous:
// reads, decisions, receipt, transition and atomic save cannot interleave between
// browser requests. No dependencies; no browser-local source of truth.
export function createFileStore({ filesystem = fs } = {}) {
    const location = root => {
        if (typeof root !== 'string' || !path.isAbsolute(root)) throw new ArcError('Authenticated user data root is required.', 'AUTH', 401);
        return path.join(root, 'ava-calendar', 'state.json');
    };
    const read = root => {
        const file = location(root);
        let text;
        try {
            if (filesystem.statSync(file).size > 1048576) throw new ArcError('Calendar record is too large.', 'CORRUPT', 500);
            text = filesystem.readFileSync(file, 'utf8');
        } catch (e) { if (e.code === 'ENOENT') return { version: 1, revision: 0, record: null }; throw e; }
        let value;
        try { value = JSON.parse(text); } catch { throw new ArcError('Calendar record is unreadable; nothing overwritten.', 'CORRUPT', 500); }
        if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !value.record) throw new ArcError('Invalid saved calendar.', 'CORRUPT', 500);
        validateRecord(value.record);
        return value;
    };
    const write = (root, envelope) => {
        const file = location(root), directory = path.dirname(file), temp = `${file}.${randomUUID()}.tmp`;
        filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
        let fd;
        try {
            fd = filesystem.openSync(temp, 'wx', 0o600);
            filesystem.writeFileSync(fd, JSON.stringify(envelope) + '\n', 'utf8');
            filesystem.fsyncSync(fd); filesystem.closeSync(fd); fd = undefined;
            filesystem.renameSync(temp, file);
            // Persist the rename on Linux. An error is an uncertain commit; retry
            // with the same revision/receipt identity, never a new random event.
            const dirFd = filesystem.openSync(directory, 'r');
            try { filesystem.fsyncSync(dirFd); } finally { filesystem.closeSync(dirFd); }
        } finally {
            if (fd !== undefined) filesystem.closeSync(fd);
            try { filesystem.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
    };
    return {
        read,
        transaction(root, mutate, expectedRevision = undefined) {
            const previous = read(root);
            if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || previous.revision !== expectedRevision)) throw new ArcError('Calendar changed; refresh before editing.', 'CONFLICT', 409);
            const next = structuredClone(previous), result = mutate(next);
            if (result?.then) throw new ArcError('Calendar transactions must be synchronous.');
            if (JSON.stringify(next.record) !== JSON.stringify(previous.record)) {
                validateRecord(next.record);
                next.revision = previous.revision + 1;
                write(root, next);
            }
            return { ...next, result };
        },
    };
}
