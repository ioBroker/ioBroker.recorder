import { SourceKind } from './types';

/** Adapters through which a person changes states directly */
const USER_ADAPTERS = new Set([
    'admin',
    'web',
    'socketio',
    'ws',
    'rest-api',
    'simple-api',
    'vis',
    'vis-2',
    'material',
    'iqontrol',
    'jarvis',
    'lovelace',
    'cloud',
    'iot',
    'alexa2',
    'matter',
    'telegram',
    'mcp',
]);

/** Adapters that run logic, i.e. automations */
const SCRIPT_ADAPTERS = new Set(['javascript', 'scenes', 'node-red', 'scheduler', 'alarm', 'flow', 'ai-server']);

/** Longest `state.c` that is stored */
const MAX_COMMENT = 200;

/**
 * The comment of a change that is stored with its source: `state.c` of an automation only. javascript writes the
 * name of the script there ("script.js.common.Light"), so the journal can say which script changed a state. Other
 * adapters may write any text into `c`, which would give a new source per change.
 *
 * @param c `state.c`
 * @param kind the kind of the source, from `classifySource`
 */
export function sourceComment(c: unknown, kind: SourceKind): string | undefined {
    if (kind !== SourceKind.Script || typeof c !== 'string') {
        return undefined;
    }
    const text = c.trim();
    return text ? text.slice(0, MAX_COMMENT) : undefined;
}

/**
 * Rough classification of `state.from`. A refined detection (a device reporting a change that
 * nobody commanded is a physical switch press) follows in milestone 3.
 *
 * @param from `state.from`, e.g. `system.adapter.vis-2.0`
 */
export function classifySource(from: string | undefined): SourceKind {
    if (!from) {
        return SourceKind.System;
    }
    if (from.startsWith('system.host.')) {
        return SourceKind.System;
    }
    const m = /^system\.adapter\.([^.]+)\.\d+$/.exec(from);
    if (!m) {
        return SourceKind.System;
    }
    if (USER_ADAPTERS.has(m[1])) {
        return SourceKind.User;
    }
    if (SCRIPT_ADAPTERS.has(m[1])) {
        return SourceKind.Script;
    }
    return SourceKind.Adapter;
}
