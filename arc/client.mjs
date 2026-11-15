import { injectState, withoutArcBlocks, ArcError } from './core.mjs';

const GENERATE = '/api/backends/chat-completions/generate';
export function createArcBridge({ fetcher, headers, binding, target, yaml, baseUrl = 'https://localhost/' }) {
    const pathOf = input => new URL(typeof input === 'string' || input instanceof URL ? input : input.url, baseUrl).pathname;
    async function send(input, options = {}, explicitTarget) {
        if (pathOf(input) !== GENERATE || String(options.method || input?.method || 'GET').toUpperCase() !== 'POST') return fetcher(input, options);
        const owner = binding();
        // Inert until an explicit Ava binding exists. No network probe on boot.
        if (!owner?.avatar) return fetcher(input, options);
        if (typeof options.body !== 'string') throw new ArcError('Calendar cannot verify this model request body. Nothing sent.');
        let data;
        try { data = JSON.parse(options.body); } catch { throw new ArcError('Invalid model request body.'); }
        const recipient = explicitTarget === undefined ? target() : explicitTarget;
        const identity = recipient ? JSON.stringify(recipient) : '';
        const isAva = recipient?.avatar === owner.avatar && !recipient.group;
        if (!Array.isArray(data.messages)) {
            if (isAva) throw new ArcError('Calendar requires Chat Completion messages.');
            return fetcher(input, options);
        }
        let state = null;
        if (isAva) {
            const decode = value => value?.trim() ? yaml.parse(value) : null;
            const include = decode(data.custom_include_body), exclude = decode(data.custom_exclude_body);
            if (include && (Object.hasOwn(include, 'messages') || Object.hasOwn(include, 'prompt')))
                throw new ArcError('Custom API body replaces calendar messages. Nothing sent.');
            const excluded = Array.isArray(exclude) ? exclude : typeof exclude === 'string' ? [exclude] : Object.keys(exclude || {});
            if (excluded.some(k => k === 'messages' || k.startsWith('messages.') || k === 'prompt')) throw new ArcError('Custom API exclusions remove calendar messages. Nothing sent.');
            const timeout = AbortSignal.timeout(12000);
            const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
            const response = await fetcher('/api/plugins/ava-calendar/state', {
                method: 'POST', headers: headers(), cache: 'no-store', signal,
                body: JSON.stringify({ avatar: owner.avatar }),
            });
            if (!response.ok) throw new ArcError(`Ava calendar unavailable (HTTP ${response.status}); model request stopped.`);
            const result = await response.json();
            state = result.state;
            if (!state || typeof state.date !== 'string' || !['cycle', 'pregnancy', 'postpartum'].includes(state.arcType)) throw new ArcError('Ava calendar is not configured; model request stopped.');
            if (binding()?.avatar !== owner.avatar || (explicitTarget === undefined && JSON.stringify(target() || null) !== (identity || 'null'))) throw new ArcError('Character changed while preparing the calendar. Nothing sent.');
        }
        options.signal?.throwIfAborted();
        data.messages = injectState(data.messages, state);
        return fetcher(input, { ...options, body: JSON.stringify(data) });
    }
    return { fetch: (input, options) => send(input, options),
        forTarget: recipient => (input, options) => send(input, options, recipient),
        stripSnapshot: messages => withoutArcBlocks(messages) };
}
export function installArcBridge({ host, ext, yaml, surface = globalThis }) {
    const original = surface.fetch;
    const current = () => {
        const c = ext.getContext();
        return { avatar: c.characters[c.characterId]?.avatar || null, group: !!c.groupId, chatId: String(c.chatId || '') };
    };
    let captured = null;
    const started = (_type, _options, dryRun) => { if (!dryRun) captured = current(); };
    const ended = () => { captured = null; };
    const getTarget = () => {
        const live = current();
        if (captured && JSON.stringify(captured) !== JSON.stringify(live)) throw new ArcError('Chat changed during generation. Nothing sent.');
        return captured || live;
    };
    const bridge = createArcBridge({ fetcher: original.bind(surface), headers: host.getRequestHeaders,
        binding: () => ext.extension_settings['ava-calendar'], target: getTarget, yaml,
        baseUrl: surface.location?.href || 'https://localhost/' });
    surface.fetch = bridge.fetch;
    host.eventSource.on(host.event_types.GENERATION_STARTED, started);
    host.eventSource.on(host.event_types.GENERATION_ENDED, ended);
    host.eventSource.on(host.event_types.GENERATION_STOPPED, ended);
    return { ...bridge, uninstall() {
        if (surface.fetch === bridge.fetch) surface.fetch = original;
        host.eventSource.removeListener(host.event_types.GENERATION_STARTED, started);
        host.eventSource.removeListener(host.event_types.GENERATION_ENDED, ended);
        host.eventSource.removeListener(host.event_types.GENERATION_STOPPED, ended);
    } };
}
