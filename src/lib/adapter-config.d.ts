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

            /** Use the presence simulation */
            simulation: boolean;
            /** State that reports absence (true: away); empty: only `simulation.enabled` */
            simTrigger: string;
            /** The trigger reports presence (true: at home) */
            simTriggerInvert: boolean;
            /** Recorded days: the same weekday 1 to N weeks back */
            simWeeks: number;
            /** Random shift of each group of actions, ± minutes */
            simJitter: number;
            /** Shift afternoon and evening by the difference of the sunsets */
            simSunset: boolean;
            /** Also switch media on and off */
            simMedia: boolean;
            /** Also play the switching of scripts */
            simScripts: boolean;
            /** Only log, switch nothing */
            simDryRun: boolean;

            /** Evaluate the anomaly rules (the statistics are collected anyway) */
            anomalies: boolean;
            /** Unusual values: z-score against the same hour of the week */
            anoValue: boolean;
            anoZ: number;
            /** ... lasting this many minutes */
            anoValueMinutes: number;
            /** Rare activity: a door at 3 am */
            anoRare: boolean;
            /** % of the weeks with activity in that hour, below: rare */
            anoRareShare: number;
            /** Silent sensor */
            anoSilent: boolean;
            /** Hours without an update at least */
            anoSilentHours: number;
            /** Open or on unusually long */
            anoLong: boolean;
            /** Times the 95th percentile of the usual duration */
            anoLongFactor: number;
            /** Window open while it is cold outside */
            anoCold: boolean;
            /** °C */
            anoColdTemp: number;
            anoColdMinutes: number;
            /** Outdoor temperature; empty: a recorded weather temperature */
            anoOutdoor: string;
            /** Racing datapoint */
            anoRacing: boolean;
            /** Times the usual changes per hour */
            anoRacingFactor: number;
            /** ioBroker notification for every new anomaly */
            anoNotify: boolean;
            /** Also send to this instance (telegram.0, pushover.0 ...) */
            anoInstance: string;
            /** At most one anomaly per datapoint and rule in this many hours */
            anoQuietHours: number;
            /** Days of statistics before a profile is used */
            anoLearnDays: number;
        }
    }
}

export {}; // required, so that the file counts as a module
