import { NAME, DEFAULTS, clone, localParts, recordKey, newDatabase, observe, plan, readBack, newestFirst, markdown, uploadEntry, backoff } from './core.mjs';
import { openStore, connectionId, captureContext, requestJournal, generateEntry, fileApi, checkStorage, registerSaved, telegramPing, saveSettingsVerified, recoverIndex } from './runtime.mjs';

export async function boot() {
    const [host, ext, api, chats, users, utils, lib, tokenizers] = await Promise.all([
        import('../../../../script.js'), import('../../../extensions.js'), import('../../../openai.js'),
        import('../../../chats.js'), import('../../../user.js'), import('../../../utils.js'), import('../../../../lib.js'), import('../../../tokenizers.js'),
    ]);
    const profile = users.getCurrentUserHandle();
    const namespace = `${NAME}:v1:${profile}`;
    const store = await openStore(namespace);
    let db = await store.read() || newDatabase();
    let settings = { ...DEFAULTS, ...ext.extension_settings[NAME] };
    let revision = 0, running = false, capturing = false, attempt = null, status = 'Journal is off.', debounceTimer;
    let generation = { type: '', automatic: false };
    let normalContext = null;
    let storageState = 'unchecked', storageError = '', storageTask = null;
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(namespace) : null;
    const files = fileApi({ headers: host.getRequestHeaders });
    const active = () => {
        const c = ext.getContext(), avatar = c.characters[c.characterId]?.avatar;
        return !c.groupId && avatar && c.chatId ? { avatar, chatId: String(c.chatId), c } : null;
    };
    const draft = () => !!String(document.getElementById('send_textarea')?.value || '').trim() || chats.hasPendingFileAttachment();
    const busy = () => host.isGenerating() || !!ext.getContext().streamingProcessor;
    const save = async () => { await store.write(db); channel?.postMessage({ kind: 'saved' }); };
    const stamp = value => {
        if (typeof value === 'number') return value;
        try { return utils.timestampToMoment(value).valueOf(); } catch { return NaN; }
    };
    const invalidate = (broadcast = true) => {
        revision++;
        if (attempt?.stage === 'generation' || capturing) {
            if (attempt) { attempt.discard = true; attempt.controller.abort(); }
        }
        if (broadcast) channel?.postMessage({ kind: 'activity' });
    };
    if (channel) channel.onmessage = event => {
        if (event.data?.kind === 'activity') invalidate(false);
        if (event.data?.kind === 'config') {
            invalidate(false); settings = { ...DEFAULTS, ...event.data.settings };
            ext.extension_settings[NAME] = clone(settings);
            panel.querySelector('#aj-enabled').checked = settings.enabled;
            panel.querySelector('#aj-hold').checked = settings.sceneHold;
            panel.querySelector('#aj-telegram').checked = settings.telegram;
            panel.querySelector('#aj-zone').value = settings.timezone;
            render();
        }
        if (event.data?.kind === 'saved' && !running) void store.read().then(value => { if (value) db = value; render(); });
    };

    const panel = document.createElement('div'); panel.id = 'ava-journal-settings'; panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Journal · 0.1.2</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content"><div class="aj-body">
      <label><input type="checkbox" id="aj-enabled"> Enable journal for this character</label>
      <div class="aj-buttons"><button type="button" class="menu_button" id="aj-storage">Check storage</button></div>
      <small id="aj-storage-status">Storage will be checked before writing. Uses a temporary test file, then removes it.</small>
      <p id="aj-character"></p>
      <button type="button" class="menu_button" id="aj-rebind">Rebind to current chat</button>
      <label><input type="checkbox" id="aj-hold"> Scene hold</label>
      <small>Pauses ordinary automatic writing and backfill. 23:30 catch-up and Write now still work.</small>
      <label>Local timezone <input id="aj-zone" class="text_pole" type="text" spellcheck="false"></label>
      <label><input type="checkbox" id="aj-telegram"> Telegram ping when an entry is saved</label>
      <small>Uses the bot already saved in Ava Initiation. Sends a generic notice, never the entry.</small>
      <div class="aj-buttons"><button type="button" class="menu_button" id="aj-write">Write now</button><button type="button" class="menu_button" id="aj-cancel" hidden>Discard pending generation</button><button type="button" class="menu_button" id="aj-backup">Download all entries</button></div>
      <p id="aj-status" role="status" aria-live="polite"></p>
      <p>VPS folder: <code id="aj-path"></code><br>Files: <code>ava-log-YYYY-MM-DD.md</code> (numbered for extra entries).</p>
      <small>Also listed in Data Bank → Character, disabled for retrieval. VPS files are not a backup; download a copy weekly.</small>
      <ol id="aj-entries"></ol></div></div></div>`;
    (document.getElementById('extensions_settings') || document.getElementById('extensions_settings2') || document.body).append(panel);
    panel.querySelector('#aj-enabled').checked = settings.enabled;
    panel.querySelector('#aj-hold').checked = settings.sceneHold;
    panel.querySelector('#aj-telegram').checked = settings.telegram;
    panel.querySelector('#aj-zone').value = settings.timezone;
    panel.querySelector('#aj-path').textContent = `data/${profile}/user/files/`;

    function download(text, name) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    function render() {
        panel.querySelector('#aj-status').textContent = status;
        panel.querySelector('#aj-character').textContent = settings.avatar ? `Character: ${settings.avatar.replace(/\.png$/i, '')}` : 'Open Ava’s chat, then enable her journal.';
        panel.querySelector('#aj-write').disabled = running || !settings.avatar;
        panel.querySelector('#aj-rebind').disabled = running || !!db.pending || storageState === 'checking';
        panel.querySelector('#aj-storage').disabled = running || storageState === 'checking';
        panel.querySelector('#aj-enabled').disabled = storageState === 'checking';
        panel.querySelector('#aj-storage-status').textContent = storageState === 'passed' ? 'Storage verified: upload, file lookup, read-back and cleanup passed.'
            : storageState === 'checking' ? 'Checking storage using your existing ST login…'
            : storageState === 'failed' ? `Storage check failed: ${storageError} Press Check storage to retry.`
            : 'Storage will be checked before writing. Uses a temporary test file, then removes it.';
        panel.querySelector('#aj-cancel').hidden = !attempt || attempt.stage !== 'generation';
        const list = panel.querySelector('#aj-entries'); list.replaceChildren();
        for (const e of db.entries.filter(e => e.avatar === settings.avatar).sort(newestFirst).slice(0, 20)) {
            const li = document.createElement('li'), a = document.createElement('a');
            a.textContent = `${e.date} · ${e.title}`; a.href = e.url; a.target = '_blank'; a.rel = 'noopener';
            li.append(a); list.append(li);
        }
    }
    async function saveConfig() {
        const hadPrevious = Object.hasOwn(ext.extension_settings, NAME);
        const previous = clone(ext.extension_settings[NAME]);
        ext.extension_settings[NAME] = clone(settings);
        try { await saveSettingsVerified(host); }
        catch (error) {
            if (hadPrevious) ext.extension_settings[NAME] = previous;
            else delete ext.extension_settings[NAME];
            settings = { ...DEFAULTS, ...previous };
            throw error;
        }
        channel?.postMessage({ kind: 'config', settings: clone(settings) });
    }
    function syncControls() {
        panel.querySelector('#aj-enabled').checked = settings.enabled;
        panel.querySelector('#aj-hold').checked = settings.sceneHold;
        panel.querySelector('#aj-telegram').checked = settings.telegram;
        panel.querySelector('#aj-zone').value = settings.timezone;
    }
    async function ensureStorage(force = false) {
        if (storageTask) return storageTask;
        if (storageState === 'passed' && !force) return;
        if (storageState === 'failed' && !force) throw new Error(`Journal paused: ${storageError} Press Check storage to retry.`);
        storageState = 'checking'; render();
        storageTask = checkStorage({ headers: host.getRequestHeaders })
            .then(() => { storageState = 'passed'; storageError = ''; })
            .catch(error => { storageState = 'failed'; storageError = error.message; throw error; })
            .finally(() => { storageTask = null; render(); });
        return storageTask;
    }
    panel.querySelector('#aj-storage').onclick = async () => {
        try { await ensureStorage(true); status = 'Storage check passed. Journal is ready to enable.'; }
        catch (error) { status = error.message; }
        render();
    };
    panel.querySelector('#aj-rebind').onclick = async () => {
        const before = clone(settings);
        try {
            if (running || db.pending) throw new Error('Finish the pending journal before rebinding.');
            const a = active();
            if (!a) throw new Error('Open the character’s one-to-one chat first.');
            // Keep every existing file/record. Rebinding selects a character,
            // not a new card, and never enables automation for it implicitly.
            settings.avatar = a.avatar; settings.enabled = false;
            invalidate(); normalContext = null;
            await saveConfig();
            status = 'Journal rebound to the current character. Enable automatic writing when ready. Existing entries are kept.';
        } catch (error) {
            settings = before; ext.extension_settings[NAME] = clone(before);
            status = error.message;
        }
        panel.querySelector('#aj-enabled').checked = settings.enabled;
        render();
    };
    panel.querySelector('#aj-enabled').onchange = async e => {
        try {
            const a = active();
            if (e.target.checked && !settings.avatar) {
                if (!a) throw new Error('Open Ava’s one-to-one chat first.');
                settings.avatar = a.avatar;
            }
            if (e.target.checked && !navigator.locks?.request) throw new Error('This browser does not support the journal’s generation lock.');
            if (e.target.checked) await ensureStorage(storageState === 'failed');
            settings.enabled = e.target.checked; invalidate(); await saveConfig();
            status = settings.enabled ? 'Journal enabled. Preparing the current conversation.' : 'Automatic writing is off.';
            render(); void tick();
        } catch (error) {
            settings = { ...DEFAULTS, ...ext.extension_settings[NAME] };
            syncControls(); status = error.message; render();
        }
    };
    for (const [id, key] of [['aj-hold', 'sceneHold'], ['aj-telegram', 'telegram']]) panel.querySelector(`#${id}`).onchange = async e => {
        try { settings[key] = e.target.checked; invalidate(); await saveConfig(); void tick(); }
        catch (error) { status = error.message; syncControls(); }
        render();
    };
    panel.querySelector('#aj-zone').onchange = async e => {
        try {
            localParts(Date.now(), e.target.value.trim());
            settings.timezone = e.target.value.trim(); invalidate(); await saveConfig(); void tick();
        } catch (error) {
            syncControls(); status = error instanceof RangeError ? 'Enter a valid timezone, for example Europe/London.' : error.message; render();
        }
    };
    panel.querySelector('#aj-write').onclick = () => void tick(true);
    panel.querySelector('#aj-cancel').onclick = () => { invalidate(); status = 'Discarding this generation.'; render(); };
    panel.querySelector('#aj-backup').onclick = async e => {
        e.target.disabled = true;
        try {
            const entries = db.entries.filter(x => x.avatar === settings.avatar).sort(newestFirst);
            if (!entries.length) throw new Error('No journal entries to download yet.');
            const parts = [];
            // Fetch the saved VPS files, rather than claiming the browser cache is a backup.
            for (const entry of entries) parts.push(`# ${entry.name}\n\n${await files.read(entry.url)}`);
            download(parts.join('\n\n'), `ava-journal-backup-${localParts(Date.now(), settings.timezone).date}.md`);
            status = 'Backup download prepared. Keep the downloaded file outside the VPS.';
        } catch (error) { status = error.message; }
        finally { e.target.disabled = false; render(); }
    };

    async function prepareSnapshot(a, date, guard) {
        const key = recordKey(a.avatar, a.chatId, date);
        const record = db.records[key] ||= { avatar: a.avatar, chatId: a.chatId, date, count: 0, lastExchange: 0, retryAt: 0 };
        if (record.snapshot) return;
        // Prefer the prompt ST actually assembled for an ordinary conversation.
        // This includes normal-generation memory interceptors, which ST skips on dry-run.
        if (normalContext?.avatar === a.avatar && normalContext.chatId === a.chatId) {
            const prefix = JSON.stringify(a.c.chat.slice(0, normalContext.length).map(m => [m.is_user, m.mes, m.send_date]));
            const extra = a.c.chat.slice(normalContext.length);
            if (prefix === normalContext.prefix && !extra.some(m => m.is_user)) {
                const last = [...a.c.chat].reverse().find(m => !m.is_system);
                if (last && localParts(stamp(last.send_date), settings.timezone).date === date) {
                    record.snapshot = { ...normalContext.snapshot, date, messages: [...clone(normalContext.snapshot.messages), ...extra.filter(m => !m.is_system && m.mes).map(m => ({ role: 'assistant', content: m.mes }))] };
                    await save(); return;
                }
            }
        }
        // A past day can only be assembled if the chat contains no later messages.
        const latest = a.c.chat.filter(m => !m.is_system).map(m => stamp(m.send_date)).filter(Number.isFinite).sort((x, y) => y - x)[0];
        if (latest && localParts(latest, settings.timezone).date > date) return;
        capturing = true;
        try {
            const messages = await captureContext({ host, c: a.c, guard });
            guard();
            record.snapshot = { messages, date, avatar: a.avatar, chatId: a.chatId, user: a.c.name1, character: a.c.name2, timezone: settings.timezone, connection: connectionId(a.c, api) };
            await save();
        } finally { capturing = false; }
    }

    async function completeSave(pending) {
        const saved = await uploadEntry({
            entry: pending.entry, text: pending.text, ...files,
            remember: async entry => { pending.entry = entry; db.pending = pending; await save(); },
            guard: () => { if (attempt?.discard) throw new Error('Conversation resumed. Journal discarded.'); },
        });
        // Keep pending state until both the file and Data Bank registration are durable.
        db.pending = { ...pending, entry: saved };
        await save();
        await registerSaved({ settings: ext.extension_settings, entry: saved, text: pending.text, saveSettings: () => saveSettingsVerified(host), now: Date.now() });
        if (!db.entries.some(e => e.url === saved.url)) db.entries.push(saved);
        db.pending = null; await save();
        status = `Saved ${saved.name}${saved.fallback ? ' · title taken from the first five body words' : ''}.`;
        if (settings.telegram) {
            try {
                const existing = ext.extension_settings['ava-initiation'] || {};
                await telegramPing({ token: existing.telegramToken, chatId: existing.telegramChatId });
            } catch { status = `Saved ${saved.name} · Telegram ping failed.`; }
        }
        render();
    }

    async function tick(manual = false) {
        if (running || !settings.avatar) return;
        if (!navigator.locks?.request) { status = 'Journal paused: browser generation locking is unavailable.'; render(); return; }
        running = true;
        try {
            await navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
                if (!lock) { if (manual) status = 'Journal is already working in another tab.'; return; }
                db = await store.read() || newDatabase();
                // Reload server-backed settings from this tab; journal never edits initiation state.
                settings = { ...DEFAULTS, ...ext.extension_settings[NAME] };
                if (settings.enabled || manual || db.pending) await ensureStorage();
                if (await recoverIndex({ db, settings: ext.extension_settings, avatar: settings.avatar, read: files.read, yaml: lib.yaml })) await save();
                const a = active(), now = Date.now();
                if (a?.avatar === settings.avatar) {
                    if (observe(db, { ...a, messages: a.c.chat, timezone: settings.timezone, now, timestamp: stamp })) await save();
                }
                if (draft() || busy()) { if (manual) status = 'Waiting: finish the draft or current generation, then press Write now.'; return; }
                if (!settings.enabled && !manual && !db.pending) return;
                // The existing initiation execution mutex coordinates provider access only.
                // No initiation state, timers, budgets, prompts or backoff are read or written.
                await navigator.locks.request(`ava-initiation:v1:${profile}`, { ifAvailable: true }, async otherLock => {
                    if (!otherLock) { status = 'Waiting for the current initiation to finish.'; return; }
                    if (draft() || busy()) return;
                    const startRevision = revision, contextIdentity = a ? `${a.avatar}:${a.chatId}` : '';
                    const guard = () => {
                        if (revision !== startRevision || draft() || attempt?.discard) throw new Error('Conversation resumed. Journal discarded.');
                        const current = active();
                        if ((current ? `${current.avatar}:${current.chatId}` : '') !== contextIdentity) throw new Error('Chat changed. Journal discarded.');
                    };
                    host.setSendButtonState(true);
                    let timer;
                    try {
                        if (db.pending) { await completeSave(db.pending); return; }
                        if (a?.avatar === settings.avatar) {
                            const date = localParts(now, settings.timezone).date;
                            if (manual || settings.enabled) await prepareSnapshot(a, date, guard);
                            // Opening yesterday's untouched recorded chat can repair a missing snapshot.
                            for (const r of Object.values(db.records).filter(r => r.avatar === a.avatar && r.chatId === a.chatId && !r.snapshot && r.date !== date)) await prepareSnapshot(a, r.date, guard);
                        }
                        const job = plan(db, settings, now, manual, a);
                        if (!job) { status = settings.enabled ? 'Ready. Waiting for the next journal opportunity.' : 'Automatic writing is off.'; return; }
                        const record = db.records[recordKey(job.avatar, job.chatId, job.date)];
                        if (!record?.snapshot) { status = `Backfill waiting for its recorded Ava chat (${job.date}). No context from another chat will be used.`; return; }
                        const previous = db.entries.filter(e => e.avatar === job.avatar && e.date <= job.date).sort(newestFirst)[0];
                        attempt = { controller: new AbortController(), discard: false, stage: 'generation' };
                        timer = setTimeout(() => { if (attempt) { attempt.discard = true; attempt.controller.abort(); } }, 150000);
                        status = `Writing ${job.date}${job.type === 'backfill' ? ' from its saved conversation' : ''}…`; render();
                        const parsed = await generateEntry({
                            generate: () => requestJournal({ c: ext.getContext(), api, yaml: lib.yaml, countMessageTokens: tokenizers.countTokensOpenAIAsync, snapshot: record.snapshot, date: job.date, previous, signal: attempt.controller.signal, guard }),
                            guard,
                            onRetry: () => { status = 'Entry missed the word count. Trying once more…'; render(); },
                        });
                        guard();
                        const entry = { ...parsed, avatar: job.avatar, chatId: job.chatId, date: job.date, created: Date.now() };
                        const text = markdown(entry, entry.created, settings.timezone);
                        attempt.stage = 'saving'; clearTimeout(timer); render();
                        db.pending = { entry, text }; await save();
                        await completeSave(db.pending);
                    } catch (error) {
                        if (attempt?.discard || error?.name === 'AbortError') {
                            status = 'Journal generation discarded. A later opportunity can try again.';
                            const job = plan(db, settings, now, manual, a);
                            const r = job && db.records[recordKey(job.avatar, job.chatId, job.date)];
                            if (r) { backoff(r, Date.now()); await save(); }
                        } else {
                            status = error.message || 'Journal failed. Nothing overwritten.';
                            const job = plan(db, settings, now, manual, a);
                            const r = job && db.records[recordKey(job.avatar, job.chatId, job.date)];
                            if (r) { backoff(r, Date.now()); await save(); }
                        }
                    } finally {
                        clearTimeout(timer); attempt = null; capturing = false;
                        if (!host.isGenerating()) host.setSendButtonState(false);
                    }
                });
            });
        } catch (error) { status = error.message || 'Journal could not run.'; }
        finally { running = false; render(); }
    }

    const schedule = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => void tick(), 2000); };
    document.getElementById('send_textarea')?.addEventListener('input', () => { invalidate(); schedule(); });
    for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED', 'CHAT_LOADED']) {
        if (host.event_types[name]) host.eventSource.on(host.event_types[name], () => { invalidate(); schedule(); });
    }
    host.eventSource.on(host.event_types.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun || capturing) return;
        invalidate(); generation = { type, automatic: !!options?.automatic_trigger };
    });
    host.eventSource.on(host.event_types.GENERATION_ENDED, schedule);
    host.eventSource.on(host.event_types.GENERATION_STOPPED, () => { invalidate(); schedule(); });
    host.eventSource.makeLast(host.event_types.CHAT_COMPLETION_SETTINGS_READY, async data => {
        if (running || generation.automatic || !['normal', undefined].includes(generation.type) || !settings.enabled) return;
        const a = active(); if (a?.avatar !== settings.avatar || !Array.isArray(data.messages)) return;
        const last = [...a.c.chat].reverse().find(m => !m.is_system);
        if (!last) return;
        const date = localParts(stamp(last.send_date), settings.timezone).date;
        normalContext = {
            avatar: a.avatar, chatId: a.chatId, length: a.c.chat.length,
            prefix: JSON.stringify(a.c.chat.map(m => [m.is_user, m.mes, m.send_date])),
            snapshot: { messages: clone(data.messages), date, avatar: a.avatar, chatId: a.chatId, user: a.c.name1, character: a.c.name2, timezone: settings.timezone, connection: connectionId(a.c, api) },
        };
        // Persist the user-side context before waiting for the assistant response.
        // On completion prepareSnapshot adds only the real response, never a fabricated turn.
        try {
            await navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
                if (!lock) return;
                db = await store.read() || newDatabase();
                observe(db, { ...a, messages: a.c.chat, timezone: settings.timezone, now: Date.now(), timestamp: stamp });
                const r = db.records[recordKey(a.avatar, a.chatId, date)];
                if (r) { r.snapshot = clone(normalContext.snapshot); await save(); }
            });
        } catch { status = 'The latest context snapshot could not be saved. Journal writing will retry.'; render(); }
    });
    host.eventSource.on(host.event_types.CHAT_COMPLETION_PROMPT_READY, event => {
        // No persistent extension prompt: read-back cannot leak into initiations,
        // journal snapshots, other quiet tasks, group chats or another character.
        if (event.dryRun || capturing || generation.automatic || !['normal', 'continue', 'swipe', 'regenerate', undefined].includes(generation.type)) return;
        const a = active(); if (a?.avatar !== settings.avatar) return;
        const text = readBack(db.entries, settings.avatar);
        if (text) event.chat.push({ role: 'system', content: text });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    window.addEventListener('pageshow', schedule);
    setInterval(() => void tick(), 30000);
    render(); schedule();
    return { tick, snapshot: () => clone(db), panel };
}

if (typeof window !== 'undefined' && globalThis.SillyTavern) {
    const start = () => boot().catch(() => {
        const p = document.createElement('p'); p.textContent = 'Ava Journal could not start. Reload SillyTavern and check browser storage is available.';
        (document.getElementById('extensions_settings') || document.body).append(p);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else void start();
}
