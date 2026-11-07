import { clone, journalMessages, registerAttachment, parseEntry, JournalWordCountError, FILE_PREFIX } from './core.mjs';

export async function openStore(name) {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('journal');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Journal storage could not be opened.'));
    });
    const transaction = (mode, operation) => new Promise((resolve, reject) => {
        const tx = db.transaction('journal', mode);
        const request = operation(tx.objectStore('journal'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(new Error('Journal storage could not be saved.'));
    });
    return { read: () => transaction('readonly', s => s.get('state')), write: value => transaction('readwrite', s => s.put(value, 'state')) };
}

export function connectionId(c, api) {
    const s = c.chatCompletionSettings;
    return JSON.stringify([s.chat_completion_source, api.getChatCompletionModel(s), s.custom_url || '', s.reverse_proxy || '']);
}

export function holdSendState(host) {
    let transferred = false, released = false;
    const onStarted = (_type, _options, dryRun) => { if (!dryRun) transferred = true; };
    host.eventSource.on(host.event_types.GENERATION_STARTED, onStarted);
    // In ST this setter changes the very flag returned by isGenerating().
    // Track ownership instead of asking that flag whether it is safe to clear.
    host.setSendButtonState(true);
    return () => {
        if (released) return;
        released = true;
        host.eventSource.removeListener(host.event_types.GENERATION_STARTED, onStarted);
        if (!transferred) host.setSendButtonState(false);
    };
}

// ST builds the character, lorebook, notes and history. No reconstruction or card edits.
export async function captureContext({ host, c, guard }) {
    let messages;
    const capture = (data, dryRun) => {
        if (!dryRun) return;
        guard();
        if (!Array.isArray(data.prompt)) throw new Error('ST did not assemble a Chat Completion context.');
        messages = clone(data.prompt);
    };
    host.eventSource.makeLast(host.event_types.GENERATE_AFTER_DATA, capture);
    try {
        guard();
        await host.Generate('quiet', { automatic_trigger: true }, true);
        guard();
        if (!messages?.length) throw new Error('ST returned an empty context. Nothing generated.');
        return messages;
    } finally {
        host.eventSource.removeListener(host.event_types.GENERATE_AFTER_DATA, capture);
    }
}

export async function fitContext(messages, countMessageTokens, budget) {
    const result = clone(messages);
    // Use ST's message tokenizer (role/content/name/tool fields), not a JSON
    // serialization of the whole prompt. Cache each count throughout trimming.
    const counts = [];
    for (const message of result) {
        const count = await countMessageTokens(message);
        if (!Number.isFinite(count) || count < 0) throw new Error('ST could not count the journal context tokens.');
        counts.push(count);
    }
    let total = counts.reduce((sum, count) => sum + count, 0);
    while (total > budget) {
        // Drop the oldest complete conversational block, never an instruction.
        const start = result.findIndex((m, i) => i < result.length - 2 && m.role !== 'system');
        if (start < 0) throw new Error('The fixed character context exceeds the journal context budget.');
        let end = start + 1;
        while (end < result.length - 2 && result[end].role !== 'user') end++;
        const indices = [];
        for (let i = start; i < end; i++) if (result[i].role !== 'system') indices.push(i);
        if (!indices.length) throw new Error('The journal context cannot fit this connection.');
        for (const i of indices.reverse()) { total -= counts[i]; counts.splice(i, 1); result.splice(i, 1); }
    }
    return result;
}

export async function generateEntry({ generate, guard, onRetry = () => {} }) {
    for (let attempt = 0; attempt < 2; attempt++) {
        guard();
        const raw = await generate();
        guard();
        try { return parseEntry(raw); }
        catch (error) {
            if (!(error instanceof JournalWordCountError) || attempt === 1) throw error;
            // Retry the identical request once. No extra authored instructions,
            // failed output in context, or relaxation of the word-count rule.
            onRetry();
        }
    }
}

export async function requestJournal({ c, api, yaml, countMessageTokens, snapshot, date, previous, instruction, signal, guard, fetcher = fetch }) {
    if (c.mainApi !== 'openai') throw new Error('Journal needs ST Chat Completion mode.');
    if (snapshot.connection !== connectionId(c, api)) throw new Error('Select the connection used by this character’s conversation before writing its journal.');
    const settings = clone(c.chatCompletionSettings);
    // Request-local values only: never modify the live preset or initiation settings.
    settings.stream_openai = false;
    settings.temp_openai = 0.95;
    settings.openai_max_tokens = 1600;
    settings.n = 1;
    const contextLimit = Number(settings.openai_max_context), budget = contextLimit - 2200;
    if (!Number.isFinite(budget) || budget < 1000) throw new Error(`Journal needs at least 3200 context tokens; this connection reports ${settings.openai_max_context ?? 'no limit'}. 2200 tokens are reserved for output and request overhead.`);
    const messages = await fitContext(journalMessages(snapshot, date, previous, instruction), countMessageTokens, budget);
    guard();
    const { generate_data: data } = await api.createGenerationParameters(settings, api.getChatCompletionModel(settings), 'quiet', messages);
    // The CUSTOM backend applies YAML after standard fields. Preserve unrelated
    // preset keys while preventing it from replacing the journal request controls.
    const reserved = ['messages', 'prompt', 'temperature', 'stream', 'n', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format'];
    let include = {};
    if (data.custom_include_body?.trim()) {
        include = yaml.parse(data.custom_include_body);
        if (!include || typeof include !== 'object' || Array.isArray(include)) throw new Error('Custom request body must be a YAML or JSON object.');
    }
    for (const key of reserved) delete include[key];
    // This is API configuration, not model instruction text.
    include.venice_parameters = { ...(include.venice_parameters || {}), enable_web_search: 'off', enable_web_scraping: false };
    data.custom_include_body = JSON.stringify(include);
    if (data.custom_exclude_body?.trim()) {
        const excluded = yaml.parse(data.custom_exclude_body);
        const keys = Array.isArray(excluded) ? excluded : typeof excluded === 'string' ? [excluded] : excluded && typeof excluded === 'object' ? Object.keys(excluded) : [];
        if (keys.some(k => reserved.includes(k))) throw new Error('Custom exclusions remove a required journal request field. Nothing sent.');
    }
    data.messages = messages;
    data.temperature = 0.95; data.stream = false; data.n = 1;
    data.max_tokens = 1600;
    if (data.max_completion_tokens != null) data.max_completion_tokens = 1600;
    delete data.tools; delete data.tool_choice; delete data.parallel_tool_calls;
    delete data.json_schema; delete data.response_format;
    data.user_name = snapshot.user; data.char_name = snapshot.character;
    guard();
    const response = await fetcher('/api/backends/chat-completions/generate', {
        method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify(data), signal,
    });
    if (!response.ok) throw new Error(`Journal generation failed (HTTP ${response.status}).`);
    const result = await response.json();
    guard();
    const choice = result?.choices?.[0];
    if (choice?.message?.tool_calls?.length) throw new Error('Journal returned a tool call instead of an entry. Nothing executed.');
    if (choice?.finish_reason === 'length') throw new Error('Journal was cut short by the model. Nothing saved.');
    const raw = choice?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('Journal returned no text. Nothing saved.');
    return raw;
}

export function fileApi({ headers, fetcher = fetch }) {
    const post = async (url, body) => {
        const response = await fetcher(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Journal file request failed (HTTP ${response.status}).`);
        return response.json();
    };
    return {
        verify: async url => {
            const data = await post('/api/files/verify', { urls: [url] });
            if (typeof data[url] !== 'boolean') throw new Error('ST could not verify the journal filename. Nothing overwritten.');
            return data[url];
        },
        upload: async (name, text) => {
            const bytes = new TextEncoder().encode(text);
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            const result = await post('/api/files/upload', { name, data: btoa(binary) });
            return result.path;
        },
        read: async url => {
            if (!/^\/user\/files\/ava-log-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(url)) throw new Error('Invalid journal file path.');
            const r = await fetcher(url, { headers: headers(), cache: 'no-store' });
            if (!r.ok) throw new Error(`Journal file could not be opened (HTTP ${r.status}).`);
            return r.text();
        },
    };
}

// Runs through the user's existing ST session. No model call, private content,
// credentials export, server installation or journal file is involved.
export async function checkStorage({ headers, fetcher = fetch, id = crypto.randomUUID() }) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid storage-check identifier.');
    const name = `ava-journal-check-${id}.txt`, url = `${FILE_PREFIX}${name}`;
    const text = `Ava Journal storage check — ${id}\n`;
    const boundedFetch = (input, options = {}) => fetcher(input, { ...options, signal: AbortSignal.timeout(20000) });
    const files = fileApi({ headers, fetcher: boundedFetch });
    if (await files.verify(url)) throw new Error('Storage-check filename already exists. Nothing overwritten.');
    const returned = await files.upload(name, text);
    if (returned !== url) throw new Error('ST returned an unexpected storage path. Journal writing stays paused.');
    if (!await files.verify(url)) throw new Error('ST could not find the uploaded check file. Journal writing stays paused.');
    const response = await boundedFetch(url, { headers: headers(), cache: 'no-store' });
    if (!response.ok) throw new Error(`Storage check could not read its file (HTTP ${response.status}).`);
    if (await response.text() !== text) throw new Error('Storage-check file did not match. Nothing deleted; journal writing stays paused.');
    // Delete only our UUID-named disposable file after confirming its exact bytes.
    const removed = await boundedFetch('/api/files/delete', { method: 'POST', headers: headers(), body: JSON.stringify({ path: url }) });
    if (!removed.ok) throw new Error(`Storage check passed read/write, but its temporary file could not be removed (HTTP ${removed.status}).`);
    if (await files.verify(url)) throw new Error('Storage-check cleanup was not confirmed. Journal writing stays paused.');
    return { upload: true, verify: true, read: true, cleanup: true };
}

export async function registerSaved({ settings, entry, text, saveSettings, now }) {
    registerAttachment(settings, entry, new TextEncoder().encode(text).byteLength, now);
    await saveSettings();
}

export async function saveSettingsVerified(host) {
    let saved = false;
    const mark = () => { saved = true; };
    host.eventSource.on(host.event_types.SETTINGS_UPDATED, mark);
    try {
        await host.saveSettings();
        // ST catches settings-save errors internally; its success event is the receipt.
        if (!saved) throw new Error('Journal settings are not saved on the server yet. They will be retried.');
    } finally { host.eventSource.removeListener(host.event_types.SETTINGS_UPDATED, mark); }
}

export async function recoverIndex({ db, settings, avatar, read, yaml }) {
    let changed = false;
    for (const attachment of settings.character_attachments?.[avatar] || []) {
        if (!/^\/user\/files\/ava-log-\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(attachment.url || '') || db.entries.some(e => e.url === attachment.url)) continue;
        const text = await read(attachment.url);
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
        if (!match) continue;
        const meta = yaml.parse(match[1]);
        if (meta?.avatar !== avatar || typeof meta.title !== 'string' || typeof meta.date !== 'string') continue;
        const body = match[2].trim();
        const sentences = body.match(/[^.!?]+(?:[.!?]+["'”’]?|$)/g)?.map(x => x.trim()).filter(Boolean) || [];
        const beat = sentences.slice(-2).join(' ');
        if (!beat || beat.length > 900) continue;
        db.entries.push({ name: attachment.url.split('/').at(-1), url: attachment.url, avatar, chatId: meta.chat_id, date: meta.date, title: meta.title, body, beat, created: Date.parse(meta.written_at) });
        changed = true;
    }
    return changed;
}

export async function telegramPing({ token, chatId, name = 'Ava', fetcher = fetch }) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '') || !chatId) throw new Error('Telegram is not configured in Ava Initiation.');
    // UI/notification copy, never sent to Ava's model. No private journal text.
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `${name} wrote a journal entry.`, disable_notification: false }),
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Journal saved; Telegram ping failed (HTTP ${response.status}).`);
    const result = await response.json();
    if (!result.ok) throw new Error('Journal saved; Telegram did not accept the notification.');
}
