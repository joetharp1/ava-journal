import { NAME, DEFAULTS, migrateConfig, characterSettings, updateCharacterConfig, planCharacters, clone, localParts, recordKey, newDatabase, observe, readBack, newestFirst, markdown, uploadEntry, backoff } from './core.mjs';
import { openStore, connectionId, holdSendState, captureContext, requestJournal, generateEntry, fileApi, checkStorage, registerSaved, telegramPing, saveSettingsVerified, recoverIndex } from './runtime.mjs';
import { installArcBridge } from './arc/client.mjs';
import { installCalendarControls } from './arc/controls.mjs';
import { journalTurn, enqueueJournal, pendingJournal, finishJournalRequest, registerJournalTool } from './journal-tool.mjs';

export async function boot() {
    const [host, ext, api, chats, users, utils, lib, tokenizers] = await Promise.all([
        import('../../../../script.js'), import('../../../extensions.js'), import('../../../openai.js'),
        import('../../../chats.js'), import('../../../user.js'), import('../../../utils.js'), import('../../../../lib.js'), import('../../../tokenizers.js'),
    ]);
    const profile = users.getCurrentUserHandle();
    const arc = installArcBridge({ host, ext, yaml: lib.yaml });
    const namespace = `${NAME}:v1:${profile}`;
    const store = await openStore(namespace);
    let db = await store.read() || newDatabase();
    let config = migrateConfig(ext.extension_settings[NAME]);
    let revision = 0, running = false, capturing = false, attempt = null, status = 'Journal is off.', debounceTimer;
    let generation = { type: '', automatic: false };
    let normalContext = null;
    let storageState = 'unchecked', storageError = '', storageTask = null;
    let journalToolTask = null;
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(namespace) : null;
    const files = fileApi({ headers: host.getRequestHeaders });
    const active = () => {
        const c = ext.getContext(), avatar = c.characters[c.characterId]?.avatar;
        return !c.groupId && avatar && c.chatId ? { avatar, chatId: String(c.chatId), c } : null;
    };
    const selectedSettings = () => {
        const a = active();
        return a ? characterSettings(config, a.avatar, a.c.name2) : { ...DEFAULTS };
    };
    const draft = () => !!String(document.getElementById('send_textarea')?.value || '').trim() || chats.hasPendingFileAttachment();
    const busy = () => {
        const stream = ext.getContext().streamingProcessor;
        return host.isGenerating() || !!(stream && !stream.isFinished && !stream.isStopped);
    };
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
            invalidate(false); config = migrateConfig(event.data.config || event.data.settings);
            ext.extension_settings[NAME] = clone(config);
            syncControls();
            render();
            if (Object.values(config.profiles).some(p => p.allowJournalTool)) void ensureJournalTool().catch(error => { status = error.message; render(); });
        }
        if (event.data?.kind === 'saved' && !running) void store.read().then(value => { if (value) db = value; render(); });
    };

    const panel = document.createElement('div'); panel.id = 'ava-journal-settings'; panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Journal · 0.3.0-alpha.3</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content"><div class="aj-body">
      <label><input type="checkbox" id="aj-enabled"> Enable journal for this character</label>
      <label><input type="checkbox" id="aj-atwill"> Allow journal requests during chats</label>
      <small>The character can request an extra entry, including when you ask. It waits for the reply and any draft to finish. Requires provider tool calling; Write now remains available.</small>
      <p id="aj-request-status" role="status" aria-live="polite"></p>
      <div class="aj-buttons"><button type="button" class="menu_button" id="aj-request-retry" hidden>Retry requested entry</button><button type="button" class="menu_button" id="aj-request-cancel" hidden>Cancel requested entry</button></div>
      <div class="aj-buttons"><button type="button" class="menu_button" id="aj-storage">Check storage</button></div>
      <small id="aj-storage-status">Storage will be checked before writing. Uses a temporary test file, then removes it.</small>
      <p id="aj-character"></p><small id="aj-profiles"></small>
      <small>Settings and journal memories belong to the character whose chat is open. Other enabled characters keep their own settings.</small>
      <details><summary>Journal writing instructions</summary><small>Keep the TITLE line and 150–250 word format so entries can be saved and remembered.</small><textarea id="aj-instruction" class="text_pole" rows="8"></textarea><button type="button" class="menu_button" id="aj-save-instruction">Save instructions for this character</button></details>
      <label><input type="checkbox" id="aj-hold"> Scene hold</label>
      <small>Pauses ordinary automatic writing and backfill. 23:30 catch-up and Write now still work.</small>
      <label>Local timezone <input id="aj-zone" class="text_pole" type="text" spellcheck="false"></label>
      <label><input type="checkbox" id="aj-telegram"> Telegram ping when an entry is saved</label>
      <small>Uses the bot already saved in Ava Initiation. Sends a generic notice, never the entry.</small>
      <div class="aj-buttons"><button type="button" class="menu_button" id="aj-write">Write now</button><button type="button" class="menu_button" id="aj-cancel" hidden>Discard pending generation</button><button type="button" class="menu_button" id="aj-backup">Download this character’s entries</button></div>
      <p id="aj-status" role="status" aria-live="polite"></p>
      <p>VPS folder: <code id="aj-path"></code><br>Files: <code>ava-log-YYYY-MM-DD.md</code> (numbered for extra entries).</p>
      <small>Also listed in Data Bank → Character, disabled for retrieval. VPS files are not a backup; download a copy weekly.</small>
      <ol id="aj-entries"></ol></div></div></div>`;
    (document.getElementById('extensions_settings') || document.getElementById('extensions_settings2') || document.body).append(panel);
    installCalendarControls({ host, ext, panel, saveSettings: () => saveSettingsVerified(host),
        loadTools: () => import('../../../tool-calling.js') });
    syncControls();
    panel.querySelector('#aj-path').textContent = `data/${profile}/user/files/`;

    function download(text, name) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    function render() {
        const settings = selectedSettings();
        panel.querySelector('#aj-status').textContent = status;
        const request = Object.values(db.journalRequests || {}).filter(r => r.avatar === settings.avatar).sort((a, b) => b.created - a.created)[0];
        panel.querySelector('#aj-request-status').textContent = request ? request.status === 'saved' ? `Requested entry saved: ${request.name}`
            : request.status === 'failed' ? `Requested entry failed: ${request.error || 'Retry when ready.'}`
            : request.status === 'cancelled' ? 'Requested entry cancelled.'
            : `Entry requested${request.focus ? ': ' + request.focus : ''}. Waiting for its recorded chat to be ready${settings.allowJournalTool ? '.' : ' and journal requests to be enabled.'}` : '';
        panel.querySelector('#aj-request-retry').hidden = request?.status !== 'failed';
        panel.querySelector('#aj-request-cancel').hidden = !['queued', 'failed'].includes(request?.status);
        panel.querySelector('#aj-request-cancel').disabled = !!request && (db.pending?.entry?.journalRequestId === request.requestId || (attempt?.requestId === request.requestId && attempt.stage === 'saving'));
        panel.querySelector('#aj-atwill').disabled = running || !settings.avatar;
        panel.querySelector('#aj-profiles').textContent = 'Enabled journals: ' + (Object.keys(config.profiles).filter(a => config.profiles[a].enabled).map(a => characterSettings(config, a).name).join(', ') || 'none');
        panel.querySelector('#aj-character').textContent = settings.avatar ? `Character: ${settings.name}` : 'Open a character’s chat to set up their journal.';
        panel.querySelector('#aj-write').disabled = running || !settings.avatar || !config.profiles[settings.avatar];
        for (const id of ['aj-hold', 'aj-telegram', 'aj-zone', 'aj-instruction', 'aj-save-instruction']) panel.querySelector(`#${id}`).disabled = running || !settings.avatar;
        panel.querySelector('#aj-storage').disabled = running || storageState === 'checking';
        panel.querySelector('#aj-enabled').disabled = running || !settings.avatar || storageState === 'checking';
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
    async function saveConfig(settings) {
        const hadPrevious = Object.hasOwn(ext.extension_settings, NAME);
        const previous = clone(ext.extension_settings[NAME]);
        const before = clone(config);
        config = updateCharacterConfig(migrateConfig(ext.extension_settings[NAME] || config), settings);
        ext.extension_settings[NAME] = clone(config);
        try { await saveSettingsVerified(host); }
        catch (error) {
            if (hadPrevious) ext.extension_settings[NAME] = previous;
            else delete ext.extension_settings[NAME];
            config = before;
            throw error;
        }
        channel?.postMessage({ kind: 'config', config: clone(config) });
    }
    function syncControls() {
        const settings = selectedSettings();
        panel.querySelector('#aj-enabled').checked = settings.enabled;
        panel.querySelector('#aj-atwill').checked = settings.allowJournalTool;
        panel.querySelector('#aj-hold').checked = settings.sceneHold;
        panel.querySelector('#aj-telegram').checked = settings.telegram;
        panel.querySelector('#aj-zone').value = settings.timezone;
        panel.querySelector('#aj-instruction').value = settings.instruction || '';
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
    function requestTarget() {
        const a = active();
        return a ? journalTurn({ avatar: a.avatar, chatId: a.chatId, messages: a.c.chat, timestamp: stamp }) : null;
    }
    const toolAllowed = () => generation.live && !running && !capturing && !generation.automatic
        && ['normal', 'continue', 'swipe', 'regenerate'].includes(generation.type)
        && selectedSettings().allowJournalTool;
    async function ensureJournalTool() {
        if (!journalToolTask) journalToolTask = import('../../../tool-calling.js').then(({ ToolManager }) => {
            registerJournalTool({ manager: ToolManager, target: requestTarget, allowed: toolAllowed,
                enqueue: async (ticket, focus) => {
                    if (!navigator.locks?.request) throw new Error('Journal generation locking is unavailable.');
                    return navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
                        if (!lock) throw new Error('Journal is busy in another tab; no request queued.');
                        const guard = () => {
                            if (!toolAllowed() || JSON.stringify(requestTarget()) !== JSON.stringify(ticket)) throw new Error('Conversation changed; no journal request queued.');
                        };
                        guard(); db = await store.read() || newDatabase(); guard();
                        const settings = selectedSettings(), now = Date.now();
                        const snapshot = normalContext?.avatar === ticket.avatar && normalContext.chatId === ticket.chatId && normalContext.requestId === ticket.requestId ? normalContext.snapshot : null;
                        const request = enqueueJournal(db, { ...ticket, focus, created: now,
                            date: localParts(now, settings.timezone).date, snapshot });
                        await save(); status = request.status === 'saved' ? 'That requested entry is already saved.' : 'Journal request received. Waiting for the reply to finish.';
                        render(); schedule(); return request;
                    });
                } });
            return ToolManager;
        }).catch(error => { journalToolTask = null; throw error; });
        return journalToolTask;
    }
    panel.querySelector('#aj-atwill').onchange = async e => {
        try {
            const settings = selectedSettings();
            if (!settings.avatar) throw new Error('Open this character’s one-to-one chat first.');
            if (e.target.checked) {
                if (!navigator.locks?.request) throw new Error('Journal generation locking is unavailable.');
                await ensureStorage(storageState === 'failed'); await ensureJournalTool();
            }
            settings.allowJournalTool = e.target.checked; invalidate(); await saveConfig(settings);
            const manager = e.target.checked ? await ensureJournalTool() : null;
            status = !e.target.checked ? 'Journal requests are paused. Queued entries remain available to resume or cancel.'
                : manager.isToolCallingSupported() ? 'Journal requests enabled. Provider tool support still needs a live check.'
                : 'Requests enabled, but current API settings do not support tool calling. Write now is available.';
            schedule();
        } catch (error) { status = error.message; }
        syncControls(); render();
    };
    async function changeRequestedEntry(cancel) {
        const avatar = selectedSettings().avatar;
        if (cancel && (attempt?.stage === 'saving' || db.pending?.entry?.journalRequestId)) throw new Error('An entry is already being saved. Finish or recover that save first.');
        if (attempt?.requestId && cancel) { attempt.cancelRequested = true; invalidate(); return; }
        if (!navigator.locks?.request) throw new Error('Journal generation locking is unavailable.');
        await navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
            if (!lock) throw new Error('Journal is working. Try again when it finishes.');
            db = await store.read() || newDatabase();
            const r = Object.values(db.journalRequests || {}).find(r => r.avatar === avatar && ['queued', 'failed'].includes(r.status));
            if (!r) return;
            r.status = cancel ? 'cancelled' : 'queued'; r.retryAt = 0; delete r.error;
            if (cancel) delete r.snapshot;
            await save();
        });
        render(); schedule();
    }
    for (const [id, cancel] of [['aj-request-retry', false], ['aj-request-cancel', true]]) panel.querySelector('#' + id).onclick = async () => {
        try { await changeRequestedEntry(cancel); } catch (error) { status = error.message; } render();
    };
    panel.querySelector('#aj-save-instruction').onclick = async () => {
        try {
            const settings = selectedSettings();
            const instruction = panel.querySelector('#aj-instruction').value.trim();
            if (!instruction) throw new Error('Journal instructions cannot be empty.');
            settings.instruction = instruction; invalidate(); await saveConfig(settings);
            status = `Journal instructions saved for ${settings.name}.`;
        } catch (error) { status = error.message; }
        syncControls(); render();
    };
    panel.querySelector('#aj-enabled').onchange = async e => {
        try {
            const settings = selectedSettings();
            if (!settings.avatar) throw new Error('Open the character’s one-to-one chat first.');
            if (e.target.checked && !navigator.locks?.request) throw new Error('This browser does not support the journal’s generation lock.');
            if (e.target.checked) await ensureStorage(storageState === 'failed');
            settings.enabled = e.target.checked; invalidate(); await saveConfig(settings);
            status = settings.enabled ? 'Journal enabled. Preparing the current conversation.' : 'Automatic writing is off.';
            render(); void tick();
        } catch (error) {
            config = migrateConfig(ext.extension_settings[NAME]);
            syncControls(); status = error.message; render();
        }
    };
    for (const [id, key] of [['aj-hold', 'sceneHold'], ['aj-telegram', 'telegram']]) panel.querySelector(`#${id}`).onchange = async e => {
        try { const settings = selectedSettings(); settings[key] = e.target.checked; invalidate(); await saveConfig(settings); void tick(); }
        catch (error) { status = error.message; syncControls(); }
        render();
    };
    panel.querySelector('#aj-zone').onchange = async e => {
        try {
            const settings = selectedSettings();
            localParts(Date.now(), e.target.value.trim());
            settings.timezone = e.target.value.trim(); invalidate(); await saveConfig(settings); void tick();
        } catch (error) {
            syncControls(); status = error instanceof RangeError ? 'Enter a valid timezone, for example Europe/London.' : error.message; render();
        }
    };
    panel.querySelector('#aj-write').onclick = () => void tick(true);
    panel.querySelector('#aj-cancel').onclick = () => { invalidate(); status = 'Discarding this generation.'; render(); };
    panel.querySelector('#aj-backup').onclick = async e => {
        e.target.disabled = true;
        const settings = selectedSettings();
        try {
            const entries = db.entries.filter(x => x.avatar === settings.avatar).sort(newestFirst);
            if (!entries.length) throw new Error('No journal entries to download yet.');
            const parts = [];
            // Fetch the saved VPS files, rather than claiming the browser cache is a backup.
            for (const entry of entries) parts.push(`# ${entry.name}\n\n${await files.read(entry.url)}`);
            download(parts.join('\n\n'), `journal-${settings.name.replace(/[^a-z0-9_-]/gi, '-')}-${localParts(Date.now(), settings.timezone).date}.md`);
            status = 'Backup download prepared. Keep the downloaded file outside the VPS.';
        } catch (error) { status = error.message; }
        finally { e.target.disabled = false; render(); }
    };

    async function prepareSnapshot(a, date, guard) {
        const settings = characterSettings(config, a.avatar, a.c.name2);
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
        const settings = characterSettings(config, pending.entry.avatar);
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
        finishJournalRequest(db, saved);
        db.pending = null; await save();
        status = `Saved ${saved.name}${saved.fallback ? ' · title taken from the first five body words' : ''}.`;
        if (settings.telegram) {
            try {
                const existing = ext.extension_settings['ava-initiation'] || {};
                await telegramPing({ token: existing.telegramToken, chatId: existing.telegramChatId, name: settings.name });
            } catch { status = `Saved ${saved.name} · Telegram ping failed.`; }
        }
        render();
    }

    async function tick(manual = false) {
        if (running) return;
        if (!navigator.locks?.request) { status = 'Journal paused: browser generation locking is unavailable.'; render(); return; }
        running = true;
        if (manual) status = 'Preparing journal…';
        render();
        try {
            await navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
                if (!lock) { if (manual) status = 'Journal is already working in another tab.'; return; }
                db = await store.read() || newDatabase();
                // Reload server-backed settings from this tab; journal never edits initiation state.
                config = migrateConfig(ext.extension_settings[NAME] || config);
                const settings = selectedSettings();
                const a = active(), now = Date.now();
                let queued = pendingJournal(db, a, settings.allowJournalTool, now);
                if (Object.values(config.profiles).some(p => p.enabled) || manual || queued || db.pending) await ensureStorage();
                for (const avatar of Object.keys(config.profiles)) if (await recoverIndex({ db, settings: ext.extension_settings, avatar, read: files.read, yaml: lib.yaml })) await save();
                if (queued) {
                    const saved = db.entries.find(e => e.journalRequestId === queued.requestId);
                    if (saved) { finishJournalRequest(db, saved); await save(); queued = null; }
                }
                if (a?.avatar === settings.avatar) {
                    if (observe(db, { ...a, messages: a.c.chat, timezone: settings.timezone, now, timestamp: stamp })) await save();
                }
                if (draft() || busy()) { if (queued) status = 'Requested entry is queued until this reply and draft finish.'; else if (manual) status = 'Waiting: finish the draft or current generation, then press Write now.'; return; }
                if (!Object.values(config.profiles).some(p => p.enabled) && !manual && !queued && !db.pending) return;
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
                    const releaseSendState = holdSendState(host);
                    let timer, job;
                    try {
                        if (db.pending) { await completeSave(db.pending); return; }
                        if (!queued && a?.avatar === settings.avatar) {
                            const date = localParts(now, settings.timezone).date;
                            if (manual || settings.enabled) await prepareSnapshot(a, date, guard);
                            // Opening yesterday's untouched recorded chat can repair a missing snapshot.
                            for (const r of Object.values(db.records).filter(r => r.avatar === a.avatar && r.chatId === a.chatId && !r.snapshot && r.date !== date)) await prepareSnapshot(a, r.date, guard);
                        }
                        job = queued ? { date: queued.date, avatar: queued.avatar, chatId: queued.chatId, type: 'requested', requestId: queued.requestId }
                            : planCharacters(db, config, now, manual, a, (snapshot, target) => snapshot && snapshot.avatar === target.avatar && snapshot.chatId === target.chatId && snapshot.connection === connectionId(ext.getContext(), api));
                        const jobSettings = job ? characterSettings(config, job.avatar) : settings;
                        if (!job) { status = Object.values(config.profiles).some(p => p.enabled) ? 'Ready. Enabled journals wait for their saved conversation, matching connection and next opportunity.' : 'Automatic writing is off.'; return; }
                        const record = queued ? { snapshot: queued.snapshot } : db.records[recordKey(job.avatar, job.chatId, job.date)];
                        if (record?.snapshot && (record.snapshot.avatar !== job.avatar || record.snapshot.chatId !== job.chatId)) throw new Error('Saved journal context does not match its character and chat.');
                        if (!record?.snapshot) { status = `Journal waiting for its recorded chat (${job.date}). No context from another chat will be used.`; return; }
                        const previous = db.entries.filter(e => e.avatar === job.avatar && e.date <= job.date).sort(newestFirst)[0];
                        attempt = { controller: new AbortController(), discard: false, stage: 'generation', requestId: job.requestId };
                        timer = setTimeout(() => { if (attempt) { attempt.discard = true; attempt.controller.abort(); } }, 150000);
                        status = `Writing ${jobSettings.name} · ${job.date}${job.type === 'backfill' ? ' from its saved conversation' : ''}…`; render();
                        const parsed = await generateEntry({
                            generate: () => requestJournal({ c: ext.getContext(), api, yaml: lib.yaml, countMessageTokens: tokenizers.countTokensOpenAIAsync, snapshot: record.snapshot, date: job.date, previous, instruction: jobSettings.instruction, request: queued, signal: attempt.controller.signal, guard,
                                fetcher: arc.forTarget({ avatar: job.avatar, group: false, chatId: job.chatId }) }),
                            guard,
                            onRetry: () => { status = 'Entry missed the word count. Trying once more…'; render(); },
                        });
                        guard();
                        const entry = { ...parsed, avatar: job.avatar, chatId: job.chatId, date: job.date, created: Date.now(), ...(job.requestId ? { journalRequestId: job.requestId } : {}) };
                        const text = markdown(entry, entry.created, queued?.snapshot.timezone || jobSettings.timezone);
                        attempt.stage = 'saving'; clearTimeout(timer); render();
                        db.pending = { entry, text }; await save();
                        await completeSave(db.pending);
                    } catch (error) {
                        status = attempt?.discard || error?.name === 'AbortError'
                            ? 'Journal generation discarded. A later opportunity can try again.'
                            : error.message || 'Journal failed. Nothing overwritten.';
                        const request = job?.requestId && db.journalRequests?.[job.requestId];
                        if (request && request.status !== 'saved') {
                            request.status = attempt?.cancelRequested ? 'cancelled' : revision !== startRevision ? 'queued' : 'failed';
                            request.error = error.message; request.retryAt = Date.now() + 2000;
                            if (request.status === 'cancelled') delete request.snapshot;
                            await save();
                        }
                        const r = !job?.requestId && job && db.records[recordKey(job.avatar, job.chatId, job.date)];
                        if (r) { backoff(r, Date.now()); await save(); }
                    } finally {
                        clearTimeout(timer); attempt = null; capturing = false;
                        releaseSendState();
                    }
                });
            });
        } catch (error) { status = error.message || 'Journal could not run.'; }
        finally { running = false; render(); }
    }

    const schedule = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(() => void tick(), 2000); };
    document.getElementById('send_textarea')?.addEventListener('input', () => { invalidate(); schedule(); });
    for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_CHANGED', 'CHAT_LOADED']) {
        if (host.event_types[name]) host.eventSource.on(host.event_types[name], () => { invalidate(); if (name === 'CHAT_CHANGED' || name === 'CHAT_LOADED') { normalContext = null; syncControls(); render(); } schedule(); });
    }
    host.eventSource.on(host.event_types.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) return;
        invalidate(); generation = { type, automatic: !!options?.automatic_trigger, live: true };
    });
    host.eventSource.on(host.event_types.GENERATION_ENDED, () => { generation.live = false; schedule(); });
    host.eventSource.on(host.event_types.GENERATION_STOPPED, () => { generation.live = false; invalidate(); schedule(); });
    host.eventSource.makeLast(host.event_types.CHAT_COMPLETION_SETTINGS_READY, async data => {
        const settings = selectedSettings();
        if (running || generation.automatic || !['normal', 'continue', 'swipe', 'regenerate', undefined].includes(generation.type) || (!settings.enabled && !settings.allowJournalTool)) return;
        const a = active(); if (a?.avatar !== settings.avatar || !Array.isArray(data.messages)) return;
        const last = [...a.c.chat].reverse().find(m => !m.is_system);
        if (!last) return;
        const date = localParts(stamp(last.send_date), settings.timezone).date;
        normalContext = {
            avatar: a.avatar, chatId: a.chatId, length: a.c.chat.length,
            requestId: requestTarget()?.requestId,
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
        const settings = selectedSettings();
        const a = active(); if (!settings.avatar || a?.avatar !== settings.avatar) return;
        const text = readBack(db.entries, settings.avatar, settings.readBackTemplate, settings.name);
        if (text) event.chat.push({ role: 'system', content: text });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    window.addEventListener('pageshow', schedule);
    setInterval(() => void tick(), 30000);
    if (Object.values(config.profiles).some(p => p.allowJournalTool)) {
        try { await ensureJournalTool(); } catch (error) { status = `Journal tool unavailable: ${error.message}`; }
    }
    render(); schedule();
    return { tick, snapshot: () => clone(db), panel };
}

if (typeof window !== 'undefined' && globalThis.SillyTavern) {
    const start = () => boot().catch(() => {
        const p = document.createElement('p'); p.textContent = 'Journal could not start. Reload SillyTavern and check browser storage is available.';
        (document.getElementById('extensions_settings') || document.body).append(p);
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else void start();
}
