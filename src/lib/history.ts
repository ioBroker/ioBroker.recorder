import {
    parseIntervalBorders,
    type AggregateMethod,
    type GetHistoryOptions,
    type IobDataEntry,
} from '@iobroker/aggregate';

import { AGG_INTERVAL, type AggregateRow } from './aggregator';
import type { Storage } from './storage';
import { DpClass, type DpInfo, type RecordedEvent, type StoredRow } from './types';
import { decodeValue } from './values';

const DAY = 86_400_000;
const HALF_INTERVAL = AGG_INTERVAL / 2;
/** Default of `limit`, as in history and sql */
const DEFAULT_LIMIT = 2000;
/** Default number of intervals of an aggregation */
const DEFAULT_COUNT = 500;

const AGGREGATES: AggregateMethod[] = [
    'none',
    'onchange',
    'minmax',
    'min',
    'max',
    'average',
    'total',
    'count',
    'percentile',
    'quantile',
    'integral',
    'integralTotal',
];

/** The options of `getHistory`, and `comment` as history has it: return `c` (the script of javascript) */
export interface HistoryOptions extends GetHistoryOptions {
    comment?: boolean;
}

/** A parsed `getHistory` request */
export interface HistoryRequest {
    id: string;
    options: HistoryOptions;
}

/** Data that is not written yet */
export interface PendingData {
    events: RecordedEvent[];
    aggregates: AggregateRow[];
}

/** A date as ms, numeric string or date string; `undefined` if it is not valid */
export function toTimestamp(value: unknown): number | undefined {
    let ts: number;
    if (typeof value === 'number') {
        ts = value;
    } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        ts = parseInt(value, 10);
    } else if (typeof value === 'string' || value instanceof Date) {
        ts = new Date(value).getTime();
    } else {
        return undefined;
    }
    return Number.isFinite(ts) ? ts : undefined;
}

function toInt(value: unknown): number {
    return typeof value === 'number' ? Math.trunc(value) : parseInt(String(value), 10);
}

/** True for the methods that return the stored values instead of intervals */
export function isRawAggregate(aggregate: AggregateMethod | undefined): boolean {
    return !aggregate || aggregate === 'none' || aggregate === 'onchange';
}

/**
 * Parses the message of `getHistory` with the same semantics as history, sql and influxdb:
 * `{ id, options: { start, end, step, count, limit, aggregate, ... } }`.
 *
 * @param message the message of `sendTo`
 * @param now the current time
 */
export function parseHistoryRequest(message: unknown, now: number = Date.now()): HistoryRequest | { error: string } {
    const msg = message as { id?: unknown; options?: Record<string, unknown> } | null | undefined;
    if (!msg?.options || typeof msg.options !== 'object') {
        return { error: 'Invalid call. No options for getHistory provided' };
    }
    if (typeof msg.id !== 'string' || !msg.id || msg.id === '*') {
        return { error: `Invalid call: ID missing in ${JSON.stringify(message)}` };
    }
    const o = msg.options;

    const aggregate = (typeof o.aggregate === 'string' && o.aggregate ? o.aggregate : 'average') as AggregateMethod;
    if (!AGGREGATES.includes(aggregate)) {
        return { error: `Invalid call. Unknown aggregate method "${aggregate}"` };
    }

    // callers send this either as a real boolean/number or as a string
    let ignoreNull: GetHistoryOptions['ignoreNull'];
    if (o.ignoreNull === true || o.ignoreNull === 'true') {
        ignoreNull = true; // replace nulls with the last value
    } else if (o.ignoreNull === 0 || o.ignoreNull === '0') {
        ignoreNull = 0; // replace nulls with 0
    } else {
        ignoreNull = false;
    }

    const count = toInt(o.count);
    const options: HistoryOptions = {
        step: toInt(o.step) || undefined,
        count,
        ignoreNull,
        aggregate,
        limit: toInt(o.limit) || count || DEFAULT_LIMIT,
        from: !!o.from,
        comment: !!o.comment,
        q: !!o.q,
        ack: !!o.ack,
        addId: !!o.addId,
        sessionId: o.sessionId as number | undefined,
        returnNewestEntries: !!o.returnNewestEntries,
        removeBorderValues: !!o.removeBorderValues,
    };
    if (aggregate === 'percentile') {
        options.percentile = toInt(o.percentile);
        if (!(options.percentile >= 0 && options.percentile <= 100)) {
            options.percentile = 50;
        }
    } else if (aggregate === 'quantile') {
        options.quantile = parseFloat(String(o.quantile));
        if (!(options.quantile >= 0 && options.quantile <= 1)) {
            options.quantile = 0.5;
        }
    } else if (aggregate === 'integral') {
        options.integralUnit = toInt(o.integralUnit);
        if (!(options.integralUnit > 0)) {
            options.integralUnit = 60;
        }
        options.integralInterpolation = o.integralInterpolation === 'linear' ? 'linear' : 'none';
    }

    if (!options.count || isNaN(options.count)) {
        options.count = isRawAggregate(aggregate) ? options.limit : DEFAULT_COUNT;
    }
    if (options.count! < 0 || options.limit! < 0) {
        return { error: 'Invalid call. count and limit must not be negative' };
    }

    if (o.start) {
        options.start = toTimestamp(o.start);
        if (options.start === undefined) {
            return { error: `Invalid call. Start date ${JSON.stringify(o.start)} is not a valid date` };
        }
    }
    if (o.end) {
        options.end = toTimestamp(o.end);
        if (options.end === undefined) {
            return { error: `Invalid call. End date ${JSON.stringify(o.end)} is not a valid date` };
        }
    } else {
        options.end = now + 5_000_000;
    }

    // the client can send the borders of the intervals itself, e.g. the local days of a chart
    const intervalBorders = parseIntervalBorders(o.intervalBorders, options.limit);
    if (intervalBorders) {
        options.intervalBorders = intervalBorders;
        options.start = intervalBorders[0];
        options.end = intervalBorders[intervalBorders.length - 1];
    }

    if (!options.start && options.count) {
        options.returnNewestEntries = true;
    }

    if (o.round !== null && o.round !== undefined && o.round !== '') {
        const digits = toInt(o.round);
        if (Number.isFinite(digits) && digits >= 0) {
            options.round = Math.pow(10, digits);
        }
    }

    if (options.start && options.start > options.end) {
        [options.start, options.end] = [options.end, options.start];
    }
    if (!options.start && !options.count) {
        options.start = now - DAY;
    }
    return { id: msg.id, options };
}

/** Keeps the oldest or the newest `limit` entries of a sorted array */
function applyLimit<T>(rows: T[], limit: number | undefined, newest: boolean): T[] {
    if (!limit || rows.length <= limit) {
        return rows;
    }
    return newest ? rows.slice(rows.length - limit) : rows.slice(0, limit);
}

function later<T extends { ts: number }>(a: T | null | undefined, b: T | null | undefined): T | null {
    if (!a) {
        return b ?? null;
    }
    return b && b.ts > a.ts ? b : a;
}

function earlier<T extends { ts: number }>(a: T | null | undefined, b: T | null | undefined): T | null {
    if (!a) {
        return b ?? null;
    }
    return b && b.ts < a.ts ? b : a;
}

/** Entries from the events of a datapoint (the changes, as recorded) */
function readEvents(storage: Storage, dp: DpInfo, options: HistoryOptions, pending: PendingData): IobDataEntry[] {
    const raw = isRawAggregate(options.aggregate);
    const start = options.start || 0;
    const end = options.end!;
    const newest = !options.start || (options.aggregate === 'none' && !!options.returnNewestEntries);
    const limit = !options.start || options.aggregate === 'none' ? options.count : undefined;

    const own: StoredRow[] = [];
    for (const e of pending.events) {
        if (e.dp === dp.id) {
            own.push({ ts: e.ts, val: e.val, sval: e.sval, ack: e.ack, src: e.src });
        }
    }
    let rows = storage
        .readEvents(dp.id, start, end, limit, newest)
        .concat(own.filter(e => e.ts >= start && e.ts < end))
        .sort((a, b) => a.ts - b.ts);
    rows = applyLimit(rows, limit, newest);

    if (options.start) {
        let before = storage.readValueBefore(dp.id, start);
        let after = storage.readEventFrom(dp.id, end);
        for (const e of own) {
            if (e.ts < start) {
                before = later(before, e);
            } else if (e.ts >= end) {
                after = earlier(after, e);
            }
        }
        if (!before) {
            // nothing before the range: the recording started within it, with a keyframe of all values
            let firstChange = Math.min(storage.readEventFrom(dp.id, start)?.ts ?? end, end);
            for (const e of own) {
                if (e.ts >= start && e.ts < firstChange) {
                    firstChange = e.ts;
                }
            }
            before = storage.readKeyframeFrom(dp.id, start, firstChange);
        }
        if (before) {
            rows.unshift(before);
        }
        if (after) {
            rows.push(after);
        }
    }

    return rows.map(row => {
        // the aggregation needs numbers: booleans are stored as 0/1 in `val`
        const val = raw ? decodeValue(row, dp.type) : row.val;
        const entry: IobDataEntry = { ts: row.ts, val: val as number | null };
        if (options.ack) {
            entry.ack = row.ack ?? true;
        }
        if ((options.from || options.comment) && row.src !== null) {
            const source = storage.getSource(row.src);
            if (options.from && source?.from) {
                entry.from = source.from;
            }
            if (options.from && source?.user) {
                entry.user = source.user;
            }
            if (options.comment && source?.comment) {
                entry.c = source.comment;
            }
        }
        return entry;
    });
}

/**
 * Entries from the 5 minute aggregates of a datapoint of class "aggregated": there are no single
 * values. Each interval gives one entry in its middle: the minimum for `min`, the maximum for
 * `max`, minimum and maximum for `minmax`, the mean for everything else.
 */
function readAggregates(
    storage: Storage,
    dp: DpInfo,
    options: GetHistoryOptions,
    pending: PendingData,
): IobDataEntry[] {
    // an interval belongs to the range if its middle does
    const start = (options.start || 0) - HALF_INTERVAL;
    const end = options.end! - HALF_INTERVAL;
    const newest = !options.start || (options.aggregate === 'none' && !!options.returnNewestEntries);
    const limit = !options.start || options.aggregate === 'none' ? options.count : undefined;

    const byTs = new Map<number, AggregateRow>();
    for (const row of storage.readAggregates(dp.id, start, end, limit, newest)) {
        byTs.set(row.ts, row);
    }
    let before: AggregateRow | null = null;
    let after: AggregateRow | null = null;
    if (options.start) {
        before = storage.readAggregateBefore(dp.id, start);
        after = storage.readAggregateFrom(dp.id, end);
    }
    for (const row of pending.aggregates) {
        // with the same start, the pending row wins
        if (row.ts < start) {
            before = before && before.ts > row.ts ? before : row;
        } else if (row.ts >= end) {
            after = after && after.ts < row.ts ? after : row;
        } else {
            // not written yet, or written partially on unload: the pending row is newer
            byTs.set(row.ts, row);
        }
    }
    const rows = applyLimit(
        [...byTs.values()].sort((a, b) => a.ts - b.ts),
        limit,
        newest,
    );

    const entries: IobDataEntry[] = [];
    const add = (ts: number, val: number): void => {
        const entry: IobDataEntry = { ts, val };
        if (options.ack) {
            entry.ack = true;
        }
        entries.push(entry);
    };
    const addRow = (row: AggregateRow): void => {
        if (options.aggregate === 'min') {
            add(row.ts + HALF_INTERVAL, row.min);
        } else if (options.aggregate === 'max') {
            add(row.ts + HALF_INTERVAL, row.max);
        } else if (options.aggregate === 'minmax') {
            add(row.ts + AGG_INTERVAL / 3, row.min);
            add(row.ts + (2 * AGG_INTERVAL) / 3, row.max);
        } else {
            add(row.ts + HALF_INTERVAL, row.avg);
        }
    };

    if (options.start) {
        // An interval exists only where samples came in: a value that seldom changes has none for
        // hours, but the hourly keyframe knows it. A keyframe taken after the interval before the
        // range ended is the newer value.
        let keyframe = storage.readValueBefore(dp.id, options.start);
        if (!keyframe && !before) {
            // nothing before the range: the recording started within it, with a keyframe of all values
            let firstInterval = storage.readAggregateFrom(dp.id, start)?.ts ?? end;
            for (const row of pending.aggregates) {
                if (row.ts >= start) {
                    firstInterval = Math.min(firstInterval, row.ts);
                }
            }
            keyframe = storage.readKeyframeFrom(dp.id, options.start, Math.min(firstInterval, end) + HALF_INTERVAL);
        }
        if (keyframe?.val != null && (!before || keyframe.ts >= before.ts + AGG_INTERVAL)) {
            add(keyframe.ts, keyframe.val);
        } else if (before) {
            addRow(before);
        }
    }
    rows.forEach(addRow);
    if (options.start && after) {
        addRow(after);
    }
    return entries;
}

/**
 * The stored values for `aggregate` and `lastChange` of the shared catalog (standardHistory.ts), read as `getHistory`
 * reads them with aggregate none: with `start` the oldest `count` values of the range (and the values just before
 * and after it), without it the newest `count` values up to `end`.
 *
 * @param storage the storage
 * @param dp the datapoint
 * @param query the range and the number of values
 * @param query.start the beginning of the range
 * @param query.end the end of the range
 * @param query.count the number of values
 * @param pending events and aggregates that are not written yet
 */
export function readStoredValues(
    storage: Storage,
    dp: DpInfo,
    query: { start?: number; end: number; count: number },
    pending: PendingData,
): IobDataEntry[] {
    const request = parseHistoryRequest({
        id: dp.oid,
        options: { start: query.start, end: query.end, count: query.count, limit: query.count, aggregate: 'none' },
    });
    if ('error' in request) {
        throw new Error(request.error);
    }
    return readHistory(storage, dp, request.options, pending);
}

/**
 * Reads the data of a `getHistory` request, sorted by time, including the values not written yet
 * and the values just before and after the range. The result is handed to `sendResponse` of
 * `@iobroker/aggregate`, which cuts and aggregates it.
 *
 * Strings and JSON cannot be aggregated: for them a numeric method falls back to `onchange`.
 *
 * @param storage the storage
 * @param dp the datapoint
 * @param options the options from `parseHistoryRequest`; `aggregate` may be changed
 * @param pending events and aggregates that are not written yet
 */
export function readHistory(
    storage: Storage,
    dp: DpInfo,
    options: HistoryOptions,
    pending: PendingData,
): IobDataEntry[] {
    if (dp.cls === DpClass.Aggregated) {
        return readAggregates(storage, dp, options, pending);
    }
    if (!isRawAggregate(options.aggregate) && (dp.type === 'string' || dp.type === 'json')) {
        options.aggregate = 'onchange';
    }
    return readEvents(storage, dp, options, pending);
}
