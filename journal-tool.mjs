export const JOURNAL_TOOL = 'write_own_journal';

// A user turn owns one request. Regenerations and tool follow-up generations do
// not create a new user turn. No model-provided IDs or transcript mutations.
export function journalTurn({ avatar, chatId, messages, timestamp }) {
    if (!avatar || !chatId) return null;
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].is_user && !messages[i].is_system) { index = i; break; }
    if (index < 0) return null;
    const at = timestamp(messages[index].send_date);
    if (!Number.isFinite(at)) return null;
    return { avatar, chatId, requestId: JSON.stringify([avatar, chatId, index, at]) };
}

export function enqueueJournal(db, request) {
    db.journalRequests ||= {};
    db.journalRequestLinks ||= {};
    const canonical = db.journalRequestLinks[request.requestId] || request.requestId;
    const existing = db.journalRequests[canonical];
    if (existing) return existing;
    const entry = db.entries.find(e => e.journalRequestId === canonical);
    if (entry) return { ...request, status: 'saved', url: entry.url, name: entry.name };
    const pending = Object.values(db.journalRequests).find(r => r.avatar === request.avatar && ['queued', 'failed'].includes(r.status));
    if (pending) { db.journalRequestLinks[request.requestId] = pending.requestId; return pending; }
    if (!request.snapshot?.messages?.length || request.snapshot.avatar !== request.avatar || request.snapshot.chatId !== request.chatId) throw new Error('Matching journal context is not available yet. Nothing queued.');
    const saved = { ...structuredClone(request), status: 'queued', retryAt: 0 };
    db.journalRequests[request.requestId] = saved;
    return saved;
}

export function pendingJournal(db, active, enabled, now) {
    if (!active || !enabled) return null;
    return Object.values(db.journalRequests || {}).find(r => r.avatar === active.avatar && r.chatId === active.chatId && r.status === 'queued' && (r.retryAt || 0) <= now) || null;
}

export function finishJournalRequest(db, entry) {
    const r = db.journalRequests?.[entry.journalRequestId];
    if (!r) return;
    r.status = 'saved'; r.url = entry.url; r.name = entry.name;
    delete r.snapshot; delete r.error;
}

export function requestReceipt(request) {
    return { status: request.status, request_id: request.requestId,
        ...(request.url ? { url: request.url, name: request.name } : {}),
        message: request.status === 'saved' ? 'This requested entry is saved.'
            : request.status === 'cancelled' ? 'This request was cancelled; do not claim it was written.'
            : request.status === 'failed' ? 'The request failed; Joe can retry it in the journal panel. Do not claim it was written.'
            : 'Journal request queued. It will write from this conversation context after the reply finishes, when no draft or other generation is active. It is not saved yet; do not claim completion.' };
}

export function registerJournalTool({ manager, target, allowed, enqueue }) {
    let captured = null;
    manager.registerFunctionTool({ name: JOURNAL_TOOL, displayName: 'Write in own journal', stealth: false,
        description: 'Request an entry in your own private journal when you want to remember something meaningful from this conversation, or when the user asks you to write in it. Use sparingly, once per user turn. This queues your existing journal writer after the current reply. A queued result is not a saved entry: acknowledge the request without claiming it is written. You may specify a brief focus, not a full entry or instructions. This tool cannot edit another character, memories, the calendar or older entries.',
        parameters: { type: 'object', additionalProperties: false, properties: { focus: { type: 'string', maxLength: 600, description: 'Optional short description of the moment or thought to remember from this conversation.' } } },
        shouldRegister() { captured = allowed() ? target() : null; return !!captured; },
        async action(args = {}) {
            const ticket = captured, current = target();
            if (!ticket || !allowed() || JSON.stringify(ticket) !== JSON.stringify(current)) throw new Error('The journal request no longer matches the active conversation.');
            if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'focus') || (args.focus !== undefined && (typeof args.focus !== 'string' || args.focus.length > 600))) throw new Error('Journal requests accept only a short optional focus.');
            return requestReceipt(await enqueue(ticket, (args.focus || '').trim()));
        },
        formatMessage: () => 'Requesting a private journal entry',
    });
    return () => { captured = null; manager.unregisterFunctionTool(JOURNAL_TOOL); };
}
