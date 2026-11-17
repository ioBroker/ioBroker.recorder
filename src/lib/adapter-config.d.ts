// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

/** off: not recorded, on: every change, aggregated: 5 minute aggregates (numbers only) */
type RecorderCategoryMode = 'off' | 'on' | 'aggregated';

/** A rule of the table "Frequency filter per role" */
interface RecorderRoleRule {
    role: string;
    deadband: number;
    /** `deadband` in % of the last stored value */
    relative: boolean;
    /** seconds */
    minInterval: number;
    /** minutes; 0: off */
    heartbeat: number;
}

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** How many days raw events and keyframes are kept: 1, 7, 30 or 90 */
            retentionDays: number;
            /** Seconds between two batched writes to the database */
            flushInterval: number;
            /** Object ID patterns (with `*`) that are always recorded */
            includePatterns: string[];
            /** Object ID patterns (with `*`) that are never recorded, even if included */
            excludePatterns: string[];
            /** Only record automatically selected states that belong to a room or function */
            requireEnum: boolean;

            catLight: RecorderCategoryMode;
            catShading: RecorderCategoryMode;
            catClimate: RecorderCategoryMode;
            catWindows: RecorderCategoryMode;
            /** Default off for privacy */
            catMotion: RecorderCategoryMode;
            catSecurity: RecorderCategoryMode;
            catSockets: RecorderCategoryMode;
            catMedia: RecorderCategoryMode;
            catWeather: RecorderCategoryMode;
            /** Default aggregated: power meters report every few seconds */
            catEnergy: RecorderCategoryMode;

            /** Numbers that change more often (per minute, average of an hour) are aggregated */
            highRate: number;
            /** A state is throttled above this many changes per minute; 0: never */
            burstLimit: number;
            /** Overrides of the frequency filter per role (pattern with `*`) */
            roleRules: RecorderRoleRule[];
            /** Create `mirror.*`: a read-only copy of every recorded state, written by the replay */
            mirrorStates: boolean;
        }
    }
}

export {}; // required, so that the file counts as a module
