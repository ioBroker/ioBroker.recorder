import { AGG_INTERVAL, type AggregateRow } from './aggregator';
import { toTimestamp } from './history';
import type { EventFilter, Storage } from './storage';
import { DpClass, SourceKind, type DpInfo, type RecordedEvent, type StoredValue } from './types';
import { decodeValue } from './values';
import type {
    EventsAnswer,
    EventsRequest,
    JournalEntry,
    SnapshotAnswer,
    SnapshotEntry,
    SnapshotRequest,
    SourceKindName,
    TimelineAnswer,
    TimelineRequest,
    WalkFilter,
} from './walk-types';

const HOUR = 3_600_000;
const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 10_000;
const DEFAULT_BUCKETS = 100;
const MAX_BUCKETS = 2000;

/** Names of `SourceKind` in the answers */
export const SOURCE_KIND_NAMES: SourceKindName[] = ['user', 'script', 'adapter', 'system'];

/** Data that is not written yet: the buffer and the open 5 minute intervals */
export interface PendingData {
    events: RecordedEvent[];
    aggregates: AggregateRow[];
}

function toList(value: unknown): string[] | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const list = Array.isArray(value) ? value : [value];
    return list.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * The datapoints that match the filter of a request: rooms (a datapoint in several rooms matches
 * each of them), categories and IDs, case-insensitive. `undefined`: no filter.
 *
 * @param storage the storage with the master data
 * @param filter room, category and ids of the request
 */
export function filterDps(storage: Storage, filter: WalkFilter): DpInfo[] | undefined {
    const rooms = toList(filter.room)?.map(r => r.toLowerCase());
    const categories = toList(filter.category)?.map(c => c.toLowerCase());
    const ids = toList(filter.ids);
    if (!rooms && !categories && !ids) {
        return undefined;
    }
    const idSet = ids ? new Set(ids) : null;
    return storage.listDps().filter(dp => {
        if (idSet && !idSet.has(dp.oid)) {
            return false;
        }
        if (categories && !categories.includes((dp.category || '').toLowerCase())) {
            return false;
        }
        if (rooms) {
            const own = (dp.room || '')
                .split(',')
                .map(r => r.trim().toLowerCase())
                .filter(Boolean);
            if (!own.some(r => rooms.includes(r))) {
                return false;
            }
        }
        return true;
    });
}

/** The `src.id`s of the requested source kinds; `undefined`: no filter */
function filterSources(storage: Storage, src: unknown): number[] | undefined {
    const names = toList(src);
    if (!names) {
        return undefined;
    }
    const kinds = new Set<SourceKind>();
    for (const name of names) {
        const kind = SOURCE_KIND_NAMES.indexOf(name.toLowerCase() as SourceKindName);
        if (kind >= 0) {
            kinds.add(kind);
        }
    }
    return storage.sourceIdsOfKinds(kinds);
}

/** The text of a value from `common.states` (object, array or the old "0:off;1:on" string) */
export function stateText(states: string | null, val: ioBroker.StateValue): string | undefined {
    if (!states || val === null || val === undefined || typeof val === 'object') {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(states);
    } catch {
        return undefined;
    }
    const key = String(val);
    if (typeof parsed === 'string') {
        for (const part of parsed.split(';')) {
            const [k, ...text] = part.split(':');
            if (k.trim() === key) {
                return text.join(':').trim();
            }
        }
        return undefined;
    }
    if (Array.isArray(parsed)) {
        // an array lists the allowed values, the value is the text
        return undefined;
    }
    if (parsed && typeof parsed === 'object') {
        const text = (parsed as Record<string, unknown>)[key];
        return typeof text === 'string' ? text : undefined;
    }
    return undefined;
}

function sourceFields(storage: Storage, src: number | null): { from?: string; user?: string; src: SourceKindName } {
    const source = src === null ? undefined : storage.getSource(src);
    const result: { from?: string; user?: string; src: SourceKindName } = {
        src: SOURCE_KIND_NAMES[source?.kind ?? SourceKind.System] || 'system',
    };
    if (source?.from) {
        result.from = source.from;
    }
    if (source?.user) {
        result.user = source.user;
    }
    return result;
}

function entryOf(dp: DpInfo, stored: StoredValue): SnapshotEntry {
    const val = decodeValue(stored, dp.type);
    const entry: SnapshotEntry = {
        id: dp.oid,
        name: dp.name,
        room: dp.room,
        func: dp.func,
        category: dp.category,
        role: dp.role,
        unit: dp.unit,
        val,
        lc: null,
    };
    const text = stateText(dp.states, val);
    if (text !== undefined) {
        entry.text = text;
    }
    return entry;
}

/**
 * Reconstructs the state of all recorded datapoints at `ts` ("walk into the past"): the last
 * keyframe at or before `ts` (written every full hour), then all changes up to `ts`. For
 * aggregated datapoints the last value of the newest 5 minute interval that is over at `ts`.
 *
 * @param storage the storage
 * @param request time and filters
 * @param pending the data that is not written yet
 * @param now the current time
 */
export function readSnapshot(
    storage: Storage,
    request: SnapshotRequest | null | undefined,
    pending: PendingData,
    now: number = Date.now(),
): SnapshotAnswer {
    const started = Date.now();
    const ts = Math.min(toTimestamp(request?.ts) ?? now, now);
    const selected = filterDps(storage, request || {});
    const allowed = selected ? new Set(selected.map(dp => dp.id)) : null;
    const filter: EventFilter | undefined = selected ? { dps: selected.map(dp => dp.id) } : undefined;

    const keyframe = storage.keyframeAtOrBefore(ts);
    if (keyframe === null) {
        return { ts, keyframe: null, states: [], ms: Date.now() - started };
    }
    const entries = new Map<number, SnapshotEntry>();
    for (const row of storage.readKeyframe(keyframe)) {
        const dp = storage.getDpById(row.dp);
        if (dp && (!allowed || allowed.has(dp.id))) {
            const entry = entryOf(dp, row);
            if (dp.cls === DpClass.Aggregated) {
                entry.aggregated = true;
            }
            entries.set(dp.id, entry);
        }
    }
    applyChanges(storage, entries, keyframe, ts, pending, allowed, filter);

    const states = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { ts, keyframe, states, ms: Date.now() - started };
}

/**
 * Per datapoint the last change in `(from, to]`: the difference between the snapshots at `from`
 * and `to`, for the replay.
 *
 * @param storage the storage
 * @param from exclusive
 * @param to inclusive
 * @param pending the data that is not written yet
 */
export function readChanges(storage: Storage, from: number, to: number, pending: PendingData): SnapshotEntry[] {
    const entries = new Map<number, SnapshotEntry>();
    applyChanges(storage, entries, from, to, pending, null, undefined);
    return [...entries.values()];
}

/**
 * Applies the changes in `(from, to]` to `entries`: events (also those still in the buffer) and
 * the 5 minute intervals of aggregated datapoints that ended in that period.
 */
function applyChanges(
    storage: Storage,
    entries: Map<number, SnapshotEntry>,
    from: number,
    to: number,
    pending: PendingData,
    allowed: Set<number> | null,
    filter: EventFilter | undefined,
): void {
    const lastTs = new Map<number, number>();
    const apply = (event: RecordedEvent): void => {
        const dp = storage.getDpById(event.dp);
        if (!dp || (allowed && !allowed.has(dp.id)) || event.ts < (lastTs.get(dp.id) ?? 0)) {
            return;
        }
        lastTs.set(dp.id, event.ts);
        entries.set(dp.id, {
            ...entryOf(dp, event),
            lc: event.ts,
            ack: event.ack,
            ...sourceFields(storage, event.src),
        });
    };
    storage.readAllEvents(from + 1, to + 1, filter).forEach(apply);
    for (const event of pending.events) {
        if (event.ts > from && event.ts <= to) {
            apply(event);
        }
    }

    const aggregates = storage.readLatestAggregates(from - AGG_INTERVAL + 1, to - AGG_INTERVAL + 1, filter);
    for (const row of pending.aggregates) {
        if (row.ts + AGG_INTERVAL > from && row.ts + AGG_INTERVAL <= to) {
            aggregates.push(row);
        }
    }
    for (const row of aggregates) {
        const dp = storage.getDpById(row.dp);
        const end = row.ts + AGG_INTERVAL;
        if (!dp || (allowed && !allowed.has(dp.id)) || end < (lastTs.get(dp.id) ?? 0)) {
            continue;
        }
        lastTs.set(dp.id, end);
        entries.set(dp.id, { ...entryOf(dp, { val: row.last, sval: null }), lc: end, aggregated: true });
    }
}

/** Start and end of a request: `end` default now, `start` default `end - defaultSpan` */
function parsePeriod(
    request: { start?: unknown; end?: unknown } | null | undefined,
    now: number,
    defaultSpan: number,
): { start: number; end: number } {
    let end = toTimestamp(request?.end) ?? now;
    let start = toTimestamp(request?.start) ?? end - defaultSpan;
    if (start > end) {
        [start, end] = [end, start];
    }
    return { start, end };
}

/**
 * The changes in a period, with names, rooms and sources, e.g. for the journal of the admin tab
 * or for an LLM ("what happened last evening?"). Aggregated datapoints have no single changes.
 *
 * @param storage the storage
 * @param request period, filters and limit
 * @param pending the data that is not written yet
 * @param now the current time
 */
export function readEventList(
    storage: Storage,
    request: EventsRequest | null | undefined,
    pending: PendingData,
    now: number = Date.now(),
): EventsAnswer {
    const started = Date.now();
    const { start, end } = parsePeriod(request, now, HOUR);
    const requested = Number(request?.limit);
    const limit = requested > 0 ? Math.min(Math.trunc(requested), MAX_EVENT_LIMIT) : DEFAULT_EVENT_LIMIT;
    const newest = request?.newest === true;
    const selected = filterDps(storage, request || {});
    const filter: EventFilter = {
        dps: selected?.map(dp => dp.id),
        srcs: filterSources(storage, request?.src),
    };

    // one more than the limit tells whether there are more
    let events = storage.readAllEvents(start, end + 1, filter, limit + 1, newest);
    const dpSet = filter.dps ? new Set(filter.dps) : null;
    const srcSet = filter.srcs ? new Set(filter.srcs) : null;
    const buffered = pending.events.filter(
        e =>
            e.ts >= start &&
            e.ts <= end &&
            (!dpSet || dpSet.has(e.dp)) &&
            (!srcSet || (e.src !== null && srcSet.has(e.src))),
    );
    if (buffered.length) {
        events = events.concat(buffered).sort((a, b) => a.ts - b.ts);
    }
    const more = events.length > limit;
    if (more) {
        events = newest ? events.slice(events.length - limit) : events.slice(0, limit);
    }

    const result: JournalEntry[] = [];
    for (const event of events) {
        const dp = storage.getDpById(event.dp);
        if (!dp) {
            continue;
        }
        const val = decodeValue(event, dp.type);
        const entry: JournalEntry = {
            ts: event.ts,
            id: dp.oid,
            name: dp.name,
            room: dp.room,
            category: dp.category,
            role: dp.role,
            unit: dp.unit,
            val,
            ack: event.ack,
            ...sourceFields(storage, event.src),
        };
        const text = stateText(dp.states, val);
        if (text !== undefined) {
            entry.text = text;
        }
        result.push(entry);
    }
    return { events: result, more, ms: Date.now() - started };
}

/**
 * The number of changes per interval, for the density on the timeline of the admin tab.
 *
 * @param storage the storage
 * @param request period, number of intervals and filters
 * @param now the current time
 */
export function readTimeline(
    storage: Storage,
    request: TimelineRequest | null | undefined,
    now: number = Date.now(),
): TimelineAnswer {
    const started = Date.now();
    const { start, end } = parsePeriod(request, now, 24 * HOUR);
    const requested = Number(request?.buckets);
    const buckets = requested > 0 ? Math.min(Math.trunc(requested), MAX_BUCKETS) : DEFAULT_BUCKETS;
    const step = Math.max(1000, Math.ceil((end - start) / buckets));
    const selected = filterDps(storage, request || {});
    const counts = storage.countEventsByBucket(start, start + step * buckets, step, {
        dps: selected?.map(dp => dp.id),
        srcs: filterSources(storage, request?.src),
    });
    return { start, end: start + step * buckets, step, counts, first: storage.oldestTs(), ms: Date.now() - started };
}
