import { ArcError, BELLIES, STAGES } from './core.mjs';

export const TOOL_NAME = 'ava_append_arc_event';
export const SETTING = 'ava-calendar';
export function createCalendarApi({ fetcher, headers }) {
    return async (operation, body) => {
        const response = await fetcher(`/api/plugins/ava-calendar/${operation}`, {
            method: 'POST', headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(12000), body: JSON.stringify(body),
        });
        let result;
        try { result = await response.json(); } catch { throw new ArcError('Calendar server plugin is unavailable.'); }
        if (!response.ok) throw new ArcError(result.error || `Calendar request failed (${response.status}).`, result.code, response.status);
        return result;
    };
}

export function registerEncounterTool({ manager, api, binding, target, allowed }) {
    let captured = null;
    const valid = t => t && !t.group && t.avatar === binding()?.avatar && !!t.chatId;
    const same = t => valid(t) && JSON.stringify(target()) === JSON.stringify(t);
    manager.registerFunctionTool({
        name: TOOL_NAME, displayName: 'Ava calendar event', stealth: false,
        description: 'Record completion of the single encounter Joe has opened in Ava’s calendar. Call once only when the current scene establishes all three facts. Do not call for hypothetical scenes, plans, memories or journal writing. This tool cannot open an encounter, change the clock or write a journal. The returned calendar result determines conception; do not invent a result.',
        parameters: { type: 'object', additionalProperties: false, required: ['unprotected', 'penetrative', 'internalCompletion'], properties: {
            unprotected: { type: 'boolean', description: 'The encounter was unprotected.' },
            penetrative: { type: 'boolean', description: 'The encounter involved penetrative sex.' },
            internalCompletion: { type: 'boolean', description: 'The encounter reached completion internally.' },
        } },
        async shouldRegister() {
            captured = null;
            const t = target();
            if (!allowed() || !valid(t)) return false;
            const result = await api('state', { avatar: t.avatar });
            if (!same(t) || !allowed() || !result.encounter?.open || result.encounter.chatId !== t.chatId) return false;
            captured = { target: structuredClone(t), encounterId: result.encounter.id };
            return true;
        },
        async action(facts) {
            const ticket = captured;
            if (!ticket || !allowed() || !same(ticket.target)) throw new ArcError('No matching Ava encounter is available.');
            const result = await api('append-event', { avatar: ticket.target.avatar, chatId: ticket.target.chatId,
                encounterId: ticket.encounterId, event: 'completed_encounter', facts });
            return { result: result.result, state: result.state };
        },
        formatMessage: () => 'Recording Ava’s calendar event',
    });
    return () => { captured = null; manager.unregisterFunctionTool(TOOL_NAME); };
}

export async function saveCalendarBinding({ ext, saveSettings, avatar }) {
    const previous = ext.extension_settings[SETTING];
    ext.extension_settings[SETTING] = { avatar };
    try { await saveSettings(); }
    catch (error) {
        if (previous === undefined) delete ext.extension_settings[SETTING];
        else ext.extension_settings[SETTING] = previous;
        throw error;
    }
}

export function installCalendarControls({ host, ext, panel, saveSettings, loadTools, surface = globalThis, document = globalThis.document }) {
    const api = createCalendarApi({ fetcher: (...args) => surface.fetch(...args), headers: host.getRequestHeaders });
    const target = () => {
        const c = ext.getContext();
        return { avatar: c.characters[c.characterId]?.avatar || null, chatId: String(c.chatId || ''), group: !!c.groupId };
    };
    const binding = () => ext.extension_settings[SETTING];
    let loaded = null, loadingTools = null, snapshot = null, busy = false, automaticError = '', generation = null, toolStatus = '';
    const section = document.createElement('details'); section.id = 'ava-calendar-controls';
    section.innerHTML = `<summary>Ava’s calendar</summary><div class="aj-body">
      <p id="ac-status" role="status" aria-live="polite">Calendar is off. Open Ava’s chat, then check the server to set up or reconnect.</p>
      <button id="ac-refresh" type="button" class="menu_button">Check server / refresh</button>
      <div id="ac-setup" hidden>
        <label><input id="ac-confirm" type="checkbox"> This character is Ava</label>
        <label>Timezone <input id="ac-zone" class="text_pole" value="Europe/London"></label>
        <label>Starting arc <select id="ac-type" class="text_pole"><option value="cycle">Cycle</option><option value="pregnancy">Pregnancy</option><option value="postpartum">Postpartum</option></select></label>
        <label>Start date <input id="ac-date" type="date" class="text_pole"></label>
        <small>Use cycle day 1, conception day 0, or birth day 0. This binds the calendar to this character.</small>
        <button id="ac-configure" type="button" class="menu_button">Create Ava’s calendar</button>
      </div>
      <div id="ac-existing" hidden>
        <p id="ac-state"></p><p id="ac-tool-status"></p>
        <button id="ac-connect" type="button" class="menu_button">Connect this device</button>
        <details><summary>Joe’s overrides</summary>
          <label>Day <input id="ac-day" type="number" min="0" step="1" class="text_pole"></label>
          <button id="ac-set-day" type="button" class="menu_button">Set day from today</button>
          <label>Stage <select id="ac-stage" class="text_pole"></select></label>
          <button id="ac-set-stage" type="button" class="menu_button">Set stage from today</button>
          <label>Belly <select id="ac-belly" class="text_pole"></select></label>
          <button id="ac-set-belly" type="button" class="menu_button">Set belly</button>
          <button id="ac-clear" type="button" class="menu_button">Clear overrides</button>
          <small>Choosing birth records it immediately. Clearing overrides does not undo a recorded birth.</small>
        </details>
        <details><summary>Encounter</summary>
          <p id="ac-encounter"></p>
          <button id="ac-begin" type="button" class="menu_button">Begin new encounter</button>
          <small>Begin once per encounter. Ava can record its completion using her tool. Reloads and regenerations reuse the result. A new encounter requires this button.</small>
          <details><summary>Record completion yourself</summary>
            <label><input id="ac-unprotected" type="checkbox"> Unprotected</label>
            <label><input id="ac-penetrative" type="checkbox"> Penetrative</label>
            <label><input id="ac-completion" type="checkbox"> Completed internally</label>
            <button id="ac-complete" type="button" class="menu_button">Record completed encounter</button>
          </details>
        </details>
        <button id="ac-export" type="button" class="menu_button">Download calendar record</button>
      </div></div>`;
    panel.querySelector('.aj-body').append(section);
    const el = id => section.querySelector('#ac-' + id);
    const owner = () => { const t = target(); if (t.group || !t.avatar || !t.chatId) throw new ArcError('Open Ava’s one-to-one chat first.'); return t; };
    const same = t => JSON.stringify(target()) === JSON.stringify(t);
    const options = (node, values) => { node.replaceChildren(...values.map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value.replaceAll('-', ' '); return option; })); };
    options(el('belly'), BELLIES);
    function show(result, t) {
        if (!same(t)) return;
        const changed = !snapshot || snapshot.revision !== result.revision || !same(snapshot.target);
        snapshot = { ...result, target: t }; el('setup').hidden = true; el('existing').hidden = false;
        const s = result.state;
        el('state').textContent = `${s.date} · ${s.arcType} day ${s.day} · ${s.stage}${s.belly ? ' · ' + s.belly : ''}${s.overrideActive ? ' · manual clock override active' : ''}`;
        if (changed) {
            el('day').value = s.day; el('day').min = s.arcType === 'cycle' ? 1 : 0;
            options(el('stage'), [...Object.keys(STAGES[s.arcType] || {}), ...(s.arcType === 'pregnancy' ? ['birth'] : [])]);
        }
        el('set-stage').disabled = s.arcType === 'cycle'; el('set-belly').disabled = s.arcType === 'cycle';
        el('connect').hidden = binding()?.avatar === t.avatar;
        el('begin').disabled = s.arcType !== 'cycle' || !s.fertile || host.isGenerating();
        const e = result.encounter;
        el('encounter').textContent = e?.receipt ? `Recorded on ${e.date}: ${e.receipt.success ? 'conception' : 'no conception'}.`
            : e?.open ? `Encounter open for ${e.date}${e.chatId !== t.chatId ? ' in another chat' : ''}.` : 'No current encounter.';
        el('complete').disabled = !e?.open || e.chatId !== t.chatId || host.isGenerating();
        el('status').textContent = binding()?.avatar === t.avatar ? 'Calendar connected. State refreshes before Ava’s requests.' : 'Server record found. Connect this device to inject it into Ava’s requests.';
        el('tool-status').textContent = toolStatus;
    }
    async function ensureTools() {
        if (!loaded && !loadingTools) loadingTools = (async () => {
            const { ToolManager } = await loadTools();
            registerEncounterTool({ manager: ToolManager, api, binding, target,
                allowed: () => !!generation && !generation.automatic && !['quiet', 'impersonate'].includes(generation.type) });
            loaded = ToolManager;
        })().catch(error => { loadingTools = null; throw error; });
        if (!loaded) await loadingTools;
        toolStatus = loaded.isToolCallingSupported() ? 'SillyTavern tool calling is enabled. Provider support still needs a live check.' : 'Tool calling is unavailable in the current API settings. Manual completion uses the same calendar rules.';
    }
    async function connect(t) {
        await saveCalendarBinding({ ext, saveSettings, avatar: t.avatar });
        await ensureTools();
    }
    async function refresh(automatic = false) {
        const t = target();
        if (t.group || !t.avatar || !t.chatId || (automatic && binding()?.avatar !== t.avatar)) return;
        if (binding()?.avatar && binding().avatar !== t.avatar) throw new ArcError('This calendar is bound to Ava. Open her chat.');
        try {
            const result = await api('inspect', { avatar: t.avatar });
            if (!same(t)) return;
            if (binding()?.avatar === t.avatar) await ensureTools();
            show(result, t);
        } catch (error) {
            if (!same(t)) return;
            if (error.code === 'NOT_CONFIGURED' && !binding()?.avatar) {
                snapshot = null; el('setup').hidden = false; el('existing').hidden = true;
                el('status').textContent = 'Server plugin found. Confirm Ava and choose her starting date.';
            } else throw error;
        }
    }
    async function run(action) {
        if (busy) return;
        busy = true;
        try { await action(); automaticError = ''; }
        catch (error) { el('status').textContent = error.message; }
        finally { busy = false; }
    }
    const button = (id, action) => el(id).addEventListener('click', () => void run(action));
    const saved = () => {
        const t = owner();
        if (!snapshot || !same(snapshot.target)) throw new ArcError('Refresh this calendar before editing.');
        if (host.isGenerating()) throw new ArcError('Wait for the current reply to finish.');
        return { avatar: t.avatar, expectedRevision: snapshot.revision, chatId: t.chatId };
    };
    const mutate = async (route, extra = {}) => {
        const b = saved(), t = owner();
        const result = await api(route, { ...b, ...extra }); show(result, t);
    };
    button('refresh', () => refresh());
    button('configure', async () => {
        const t = owner();
        if (!el('confirm').checked) throw new ArcError('Confirm that this character is Ava.');
        const result = await api('configure', { avatar: t.avatar, confirmAva: true, expectedRevision: 0,
            timezone: el('zone').value.trim(), arcType: el('type').value, startDate: el('date').value });
        if (!same(t)) throw new ArcError('Calendar saved on the server. Return to Ava and refresh to connect.');
        show(result, t); await connect(t); await refresh();
    });
    button('connect', async () => { const t = owner(); saved(); await connect(t); await refresh(); });
    button('set-day', () => {
        if (!String(el('day').value).trim()) throw new ArcError('Enter a day first.');
        return mutate('override', { change: { kind: 'day', value: Number(el('day').value) } });
    });
    button('set-stage', () => mutate('override', { change: { kind: 'stage', value: el('stage').value } }));
    button('set-belly', () => mutate('belly', { value: el('belly').value }));
    button('clear', () => mutate('clear-override'));
    button('begin', async () => { await mutate('begin-encounter'); for (const key of ['unprotected', 'penetrative', 'completion']) el(key).checked = false; });
    button('complete', () => mutate('append-event', { encounterId: snapshot?.encounter?.id, event: 'completed_encounter', facts: {
        unprotected: el('unprotected').checked, penetrative: el('penetrative').checked, internalCompletion: el('completion').checked,
    } }));
    button('export', async () => {
        const b = saved(), result = await api('inspect', { avatar: b.avatar });
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'ava-calendar-record.json'; a.click();
        surface.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const tick = async () => {
        if (busy || document.hidden || !binding()?.avatar) return;
        busy = true;
        try { await refresh(true); automaticError = ''; }
        catch (error) { if (automaticError !== error.message) { automaticError = error.message; el('status').textContent = error.message; } }
        finally { busy = false; }
    };
    host.eventSource.on(host.event_types.GENERATION_STARTED, (type, opts, dry) => { if (!dry) generation = { type, automatic: !!opts?.automatic_trigger }; });
    for (const key of ['GENERATION_ENDED', 'GENERATION_STOPPED']) host.eventSource.on(host.event_types[key], () => { generation = null; void tick(); });
    host.eventSource.on(host.event_types.CHAT_CHANGED, () => {
        snapshot = null; generation = null; el('setup').hidden = true; el('existing').hidden = true;
        el('status').textContent = binding()?.avatar === target().avatar ? 'Refreshing Ava’s calendar…' : 'Open Ava’s chat to use her calendar.';
        void tick();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void tick(); });
    surface.addEventListener('focus', () => void tick());
    surface.setInterval(() => void tick(), 60000);
    void tick();
    return { refresh, tick };
}
