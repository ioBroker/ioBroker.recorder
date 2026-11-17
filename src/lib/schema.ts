import type { SqliteDatabase } from './sqlite';
import { toNumber } from './sqlite';

/**
 * Schema of `meta.sqlite`: master data, classification, statistics and profiles.
 * The version is kept in `PRAGMA user_version`; a new version needs a migration in `MIGRATIONS_META`.
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

const META_VERSION = 1;
const EVENTS_VERSION = 1;

function getVersion(db: SqliteDatabase): number {
    return toNumber(db.prepare('PRAGMA user_version').get()?.user_version) ?? 0;
}

function applySchema(db: SqliteDatabase, schema: string, version: number, fileName: string): void {
    const current = getVersion(db);
    if (current > version) {
        throw new Error(
            `${fileName} has schema version ${current}, but this adapter only knows ${version}. Please update the adapter.`,
        );
    }
    if (current < version) {
        db.exec('BEGIN');
        try {
            db.exec(schema);
            db.exec(`PRAGMA user_version = ${version}`);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}

export function initMetaSchema(db: SqliteDatabase): void {
    applySchema(db, META_SCHEMA_V1, META_VERSION, 'meta.sqlite');
}

export function initEventsSchema(db: SqliteDatabase, fileName: string): void {
    applySchema(db, EVENTS_SCHEMA_V1, EVENTS_VERSION, fileName);
}
