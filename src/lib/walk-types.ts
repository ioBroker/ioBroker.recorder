/**
 * Answers of the "walk into the past" commands (`getSnapshot`, `getEvents`, `getTimeline`).
 * Only types: the admin tab (`src-tab`) imports this file as well.
 */

/** Who caused a change */
export type SourceKindName = 'user' | 'script' | 'adapter' | 'system';

/** Filters shared by the commands; every one accepts a single value or a list */
export interface WalkFilter {
    /** Room names as in `dp.room`, e.g. "Bad" */
    room?: string | string[];
    /** Category keys, e.g. "light", "windowsDoors" */
    category?: string | string[];
    /** Object IDs */
    ids?: string | string[];
}

/** `getSnapshot`: the state of all recorded datapoints at `ts` */
export interface SnapshotRequest extends WalkFilter {
    /** ms, ISO string or anything `new Date()` understands; default: now */
    ts?: number | string;
}

/** The value of one datapoint in a snapshot */
export interface SnapshotEntry {
    id: string;
    name: string | null;
    room: string | null;
    func: string | null;
    category: string | null;
    role: string | null;
    unit: string | null;
    val: ioBroker.StateValue;
    /** Text of the value from `common.states`, e.g. "open" for 2 */
    text?: string;
    /** Time of the last change if it lies between the keyframe and `ts`, else `null` */
    lc: number | null;
    /** Only for a change after the keyframe */
    ack?: boolean;
    from?: string;
    user?: string;
    src?: SourceKindName;
    /** High-frequency datapoint: the last value of the last finished 5 minute interval */
    aggregated?: true;
}

export interface SnapshotAnswer {
    /** The requested time */
    ts: number;
    /** Time of the keyframe the snapshot is based on; `null`: nothing was recorded before `ts` */
    keyframe: number | null;
    states: SnapshotEntry[];
    /** Time to compute the answer in ms */
    ms: number;
    error?: string;
}

/** `getEvents`: the changes in a period */
export interface EventsRequest extends WalkFilter {
    /** Default: `end` - 1 hour */
    start?: number | string;
    /** Default: now */
    end?: number | string;
    /** Source kinds, e.g. "user" for manual actions only */
    src?: SourceKindName | SourceKindName[];
    /** Default 1000, at most 10000 */
    limit?: number;
    /** With more than `limit` events: the newest ones instead of the oldest */
    newest?: boolean;
}

/** One change */
export interface JournalEntry {
    ts: number;
    id: string;
    name: string | null;
    room: string | null;
    category: string | null;
    role: string | null;
    unit: string | null;
    val: ioBroker.StateValue;
    text?: string;
    ack: boolean;
    from?: string;
    user?: string;
    src: SourceKindName;
}

export interface EventsAnswer {
    /** Sorted by time, oldest first */
    events: JournalEntry[];
    /** There were more than `limit` events */
    more: boolean;
    ms: number;
    error?: string;
}

/** `getTimeline`: the number of changes per interval, for the density on the timeline */
export interface TimelineRequest extends WalkFilter {
    start?: number | string;
    end?: number | string;
    /** Number of intervals, default 100, at most 2000 */
    buckets?: number;
    src?: SourceKindName | SourceKindName[];
}

export interface TimelineAnswer {
    start: number;
    end: number;
    /** Length of one interval in ms */
    step: number;
    counts: number[];
    /** The oldest recorded time; `null` if nothing is recorded */
    first: number | null;
    ms: number;
    error?: string;
}
