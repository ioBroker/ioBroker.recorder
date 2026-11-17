/** Who caused a state change. Stored as `src.kind` in meta.sqlite. */
export enum SourceKind {
    /** A person, via a user interface (admin, vis, app, voice assistant ...) */
    User = 0,
    /** A script or a logic adapter (javascript, scenes, node-red ...) */
    Script = 1,
    /** Any other adapter, usually the device adapter reporting a value */
    Adapter = 2,
    /** js-controller, a host or unknown */
    System = 3,
}

/** Storage class of a datapoint. Stored as `dp.cls` in meta.sqlite. */
export enum DpClass {
    /** Every real change is stored (booleans, lists of states) */
    Discrete = 0,
    /** Numbers: dead band, minimum interval and heartbeat (milestone 3) */
    Continuous = 1,
    /** High-frequency values: only 5 minute aggregates (milestone 3) */
    Aggregated = 2,
    /** Not stored at all, but visible in the admin */
    Discarded = 3,
}

/** How a value is encoded in the `val` / `sval` columns */
export type ValueType = 'boolean' | 'number' | 'string' | 'json';

/** Master data of one recorded datapoint (table `dp` in meta.sqlite) */
export interface DpInfo {
    /** Numeric ID, the key used in all event tables */
    id: number;
    /** ioBroker object ID */
    oid: string;
    name: string | null;
    room: string | null;
    func: string | null;
    role: string | null;
    unit: string | null;
    /** Device type from the type detector (milestone 2) */
    devType: string | null;
    category: string | null;
    cls: DpClass;
    /** How the value is encoded, derived from `common.type` */
    type: ValueType;
    /** JSON of `common.states`, if present */
    states: string | null;
    firstSeen: number;
    lastSeen: number;
    active: boolean;
}

/** The attributes of a datapoint that come from its object; `id`, `firstSeen` and `lastSeen` are managed by the storage */
export type DpDefinition = Omit<DpInfo, 'id' | 'firstSeen' | 'lastSeen' | 'active'>;

/** A value as stored in the database: numbers and booleans in `val`, strings and JSON in `sval` */
export interface StoredValue {
    val: number | null;
    sval: string | null;
}

/** One row of the table `ev` */
export interface RecordedEvent extends StoredValue {
    /** Timestamp in ms */
    ts: number;
    /** `dp.id` */
    dp: number;
    ack: boolean;
    /** `src.id` */
    src: number | null;
}

/** One row of the table `keyframe` */
export interface KeyframeRow extends StoredValue {
    dp: number;
}

/** A keyframe: the state of all active datapoints at `ts` */
export interface Keyframe {
    ts: number;
    rows: KeyframeRow[];
}

/** One stored value as it is read back */
export interface StoredRow extends StoredValue {
    ts: number;
    /** `null` for values from a keyframe */
    ack: boolean | null;
    /** ID in the table `src`; `null` for values from a keyframe */
    src: number | null;
}

/** Measured change rate of a datapoint (table `rate`) */
export interface RateInfo {
    /** Changes per minute in the last measured hour */
    perMin: number;
    /** Highest hourly rate measured */
    maxPerMin: number;
    /** Classified as high-frequency (with hysteresis) */
    high: boolean;
    /** End of the last measurement */
    ts: number;
}

/** The rules of the anomaly detection */
export type AnomalyRule = 'value' | 'rare' | 'silent' | 'long' | 'cold' | 'racing';

/** One row of the table `anomaly` */
export interface AnomalyRecord {
    id: number;
    /** `dp.id` */
    dp: number;
    rule: AnomalyRule;
    /** Detected */
    ts: number;
    /** The condition is over */
    endTs: number | null;
    /** Acknowledged */
    ackTs: number | null;
    val: number | null;
    text: string;
}

/** Per datapoint: what is usual, from the statistics of the last weeks (table `baseline`) */
export interface Baseline {
    dp: number;
    /** First hour with statistics */
    since: number;
    /** Hours with statistics */
    hours: number;
    updates: number;
    changes: number;
    /** Longest time without an update, ms */
    maxGap: number;
    /** 95th percentile of the duration of the active state (on, open), ms; 0 if unknown */
    onP95: number;
    /** Active periods measured */
    onCount: number;
}
