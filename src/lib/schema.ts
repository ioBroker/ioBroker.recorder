import type { SqliteDatabase } from './sqlite';
import { toNumber } from './sqlite';

/**
 * Schema of `meta.sqlite`: master data, classification, statistics and profiles.
 * The version is kept in `PRAGMA user_version`; every version is one migration in `META_MIGRATIONS`.
 */
const META_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS dp (
    id        INTEGER PRIMARY KEY,
    oid       TEXT UNIQUE NOT NULL,
    name      TEXT,
    room      TEXT,
    func      TEXT,
    role      TEXT,
    unit      TEXT,
    devType   TEXT,
    category  TEXT,
    cls       INTEGER NOT NULL,          -- 0 discrete, 1 continuous, 2 aggregated, 3 discarded
    type      TEXT NOT NULL,             -- boolean, number, string, json: how val/sval are encoded
    states    TEXT,                      -- JSON of common.states, if present
    firstSeen INTEGER,
    lastSeen  INTEGER,
    active    INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS src (         -- deduplicated sources of changes
    id     INTEGER PRIMARY KEY,
    fromId TEXT,
    userId TEXT,
    kind   INTEGER                       -- 0 user, 1 script, 2 adapter, 3 system
);
CREATE UNIQUE INDEX IF NOT EXISTS src_from_user ON src(fromId, userId);

CREATE TABLE IF NOT EXISTS stat_hour (
    ts      INTEGER,
    dp      INTEGER,
    min     REAL,
    max     REAL,
    avg     REAL,
    last    REAL,
    onSec   INTEGER,                     -- discrete values: seconds in state true/active
    changes INTEGER,
    PRIMARY KEY (dp, ts)
);

CREATE TABLE IF NOT EXISTS profile (     -- base for anomaly detection
    dp         INTEGER,
    how        INTEGER,                  -- hour of week 0..167
    n          INTEGER,
    mean       REAL,
    m2         REAL,                     -- Welford for variance
    pActive    REAL,
    avgChanges REAL,
    PRIMARY KEY (dp, how)
);
`;

/** Schema of `ev-YYYY-Www.sqlite`: events, keyframes and 5 minute aggregates of one week */
const EVENTS_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS ev (
    ts   INTEGER NOT NULL,               -- ms
    dp   INTEGER NOT NULL,
    val  REAL,                           -- number, or boolean as 0/1
    sval TEXT,                           -- strings and JSON only
    ack  INTEGER,
    src  INTEGER
);
CREATE INDEX IF NOT EXISTS ev_ts    ON ev(ts);
CREATE INDEX IF NOT EXISTS ev_dp_ts ON ev(dp, ts);

CREATE TABLE IF NOT EXISTS keyframe (    -- state of all active datapoints, hourly
    ts   INTEGER,
    dp   INTEGER,
    val  REAL,
    sval TEXT,
    PRIMARY KEY (ts, dp)
);

CREATE TABLE IF NOT EXISTS agg5 (        -- 5 minute aggregates of high-frequency datapoints
    ts   INTEGER,
    dp   INTEGER,
    min  REAL,
    max  REAL,
    avg  REAL,
    last REAL,
    PRIMARY KEY (dp, ts)
);
`;

/** Version 2: measured change rates and the classification as high-frequency (M3) */
const META_SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS rate (
    dp        INTEGER PRIMARY KEY,
    perMin    REAL,                      -- changes per minute in the last measured hour
    maxPerMin REAL,                      -- highest hourly rate measured
    high      INTEGER,                   -- 1: classified as high-frequency
    ts        INTEGER                    -- end of the last measurement
);
`;

/**
 * Version 3: statistics and anomalies (M6). `stat_hour` and `profile` of version 1 were never
 * written, so they are created anew with the columns the detection needs.
 */
const META_SCHEMA_V3 = `
DROP TABLE IF EXISTS stat_hour;
CREATE TABLE stat_hour (
    ts      INTEGER,                     -- start of the hour
    dp      INTEGER,
    how     INTEGER,                     -- local hour of the week 0..167 (Monday 00:00 = 0)
    min     REAL,
    max     REAL,
    avg     REAL,                        -- time-weighted mean
    last    REAL,
    onSec   INTEGER,                     -- seconds with a value > 0 (on, open)
    changes INTEGER,
    updates INTEGER,                     -- also without a change of value
    maxGap  INTEGER,                     -- longest time without an update that ended in this hour, ms
    PRIMARY KEY (dp, ts)
);
CREATE INDEX stat_hour_ts ON stat_hour(ts);

DROP TABLE IF EXISTS profile;
CREATE TABLE profile (                   -- one hour of the week of one datapoint
    dp         INTEGER,
    how        INTEGER,
    n          INTEGER,                  -- hours observed
    nVal       INTEGER,                  -- hours with a numeric mean
    mean       REAL,
    m2         REAL,                     -- Welford: sum of squared deviations
    pActive    REAL,                     -- share of hours with a change
    avgChanges REAL,
    avgUpdates REAL,
    min        REAL,
    max        REAL,
    PRIMARY KEY (dp, how)
);

DROP TABLE IF EXISTS baseline;
CREATE TABLE baseline (                  -- per datapoint, computed daily from stat_hour and the events
    dp      INTEGER PRIMARY KEY,
    since   INTEGER,                     -- first hour with statistics
    hours   INTEGER,                     -- hours with statistics in the profile period
    updates INTEGER,
    changes INTEGER,
    maxGap  INTEGER,                     -- longest time without an update, ms
    onP95   INTEGER,                     -- 95th percentile of the duration of the active state, ms
    onCount INTEGER,                     -- active periods measured
    ts      INTEGER                      -- computed at
);

CREATE TABLE IF NOT EXISTS anomaly (
    id    INTEGER PRIMARY KEY,
    dp    INTEGER,
    rule  TEXT,
    ts    INTEGER,                       -- detected
    endTs INTEGER,                       -- the condition is over
    ackTs INTEGER,                       -- acknowledged
    val   REAL,
    text  TEXT
);
CREATE INDEX IF NOT EXISTS anomaly_ts ON anomaly(ts);
`;

/**
 * Version 4: statistics computed afterwards from the recording (backfill). The recording knows no
 * updates without a change of value and no changes held back by the frequency filter, so the
 * baseline takes updates, changes and gaps from the live rows only.
 */
const META_SCHEMA_V4 = `
ALTER TABLE stat_hour ADD COLUMN bf INTEGER NOT NULL DEFAULT 0;   -- 1: computed from the recording
ALTER TABLE baseline ADD COLUMN liveSince INTEGER;                -- first hour of the live statistics
`;

/**
 * Version 5: `stat_hour` clustered by time, so that the hourly rows and the backfill are appended
 * (few pages per write, small WAL) and the daily rebuild reads it in order; `profile` clustered
 * by the hour of the week, so that the detector reads the hours it needs. The profile is no longer
 * updated every hour, only rebuilt daily: the baseline is cleared, so the next start rebuilds it.
 */
const META_SCHEMA_V5 = `
CREATE TABLE stat_hour_v5 (
    ts      INTEGER NOT NULL,            -- start of the hour
    dp      INTEGER NOT NULL,
    how     INTEGER,                     -- local hour of the week 0..167 (Monday 00:00 = 0)
    min     REAL,
    max     REAL,
    avg     REAL,                        -- time-weighted mean
    last    REAL,
    onSec   INTEGER,                     -- seconds with a value > 0 (on, open)
    changes INTEGER,
    updates INTEGER,                     -- also without a change of value
    maxGap  INTEGER,                     -- longest time without an update that ended in this hour, ms
    bf      INTEGER NOT NULL DEFAULT 0,  -- 1: computed from the recording
    PRIMARY KEY (ts, dp)
) WITHOUT ROWID;
INSERT INTO stat_hour_v5 SELECT ts, dp, how, min, max, avg, last, onSec, changes, updates, maxGap, bf FROM stat_hour;
DROP TABLE stat_hour;
ALTER TABLE stat_hour_v5 RENAME TO stat_hour;
CREATE INDEX stat_hour_bf ON stat_hour(bf, ts);

DROP TABLE profile;
CREATE TABLE profile (                   -- one hour of the week of one datapoint
    how        INTEGER NOT NULL,
    dp         INTEGER NOT NULL,
    n          INTEGER,                  -- hours observed
    nVal       INTEGER,                  -- hours with a numeric mean
    mean       REAL,
    m2         REAL,                     -- Welford: sum of squared deviations
    pActive    REAL,                     -- share of hours with a change
    avgChanges REAL,
    avgUpdates REAL,
    min        REAL,
    max        REAL,
    PRIMARY KEY (how, dp)
) WITHOUT ROWID;

DELETE FROM baseline;
`;

/**
 * v6: `state.c` of automations (javascript writes the name of the script there) is part of the source, so the
 * journal can say which script changed a state. Older sources keep `comment` NULL.
 */
function metaSchemaV6(db: SqliteDatabase): void {
    // SQLite has no ADD COLUMN IF NOT EXISTS
    if (
        !db
            .prepare('PRAGMA table_info(src)')
            .all()
            .some(column => column.name === 'comment')
    ) {
        db.exec('ALTER TABLE src ADD COLUMN comment TEXT');
    }
    db.exec(`DROP INDEX IF EXISTS src_from_user;
        CREATE UNIQUE INDEX IF NOT EXISTS src_from_user_comment ON src(fromId, userId, comment);`);
}

/** A migration: SQL, or a function for what SQL cannot say */
type Migration = string | ((db: SqliteDatabase) => void);

/** Index = version - 1. Each migration runs once, in one transaction with the version update. */
const META_MIGRATIONS: Migration[] = [
    META_SCHEMA_V1,
    META_SCHEMA_V2,
    META_SCHEMA_V3,
    META_SCHEMA_V4,
    META_SCHEMA_V5,
    metaSchemaV6,
];
const EVENTS_MIGRATIONS = [EVENTS_SCHEMA_V1];

function getVersion(db: SqliteDatabase): number {
    return toNumber(db.prepare('PRAGMA user_version').get()?.user_version) ?? 0;
}

function applySchema(db: SqliteDatabase, migrations: Migration[], fileName: string): void {
    const version = migrations.length;
    const current = getVersion(db);
    if (current > version) {
        throw new Error(
            `${fileName} has schema version ${current}, but this adapter only knows ${version}. Please update the adapter.`,
        );
    }
    if (current < version) {
        db.exec('BEGIN');
        try {
            for (let v = current; v < version; v++) {
                const migration = migrations[v];
                if (typeof migration === 'string') {
                    db.exec(migration);
                } else {
                    migration(db);
                }
            }
            db.exec(`PRAGMA user_version = ${version}`);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}

export function initMetaSchema(db: SqliteDatabase): void {
    applySchema(db, META_MIGRATIONS, 'meta.sqlite');
}

export function initEventsSchema(db: SqliteDatabase, fileName: string): void {
    applySchema(db, EVENTS_MIGRATIONS, fileName);
}
