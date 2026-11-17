import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { AggregateRow } from './aggregator';
import { initEventsSchema, initMetaSchema } from './schema';
import {
    openDatabase,
    toNumber,
    toText,
    transaction,
    type Row,
    type SqliteDatabase,
    type SqliteStatement,
} from './sqlite';
import {
    DpClass,
    type DpDefinition,
    type DpInfo,
    type Keyframe,
    type RateInfo,
    type RecordedEvent,
    type SourceKind,
    type StoredRow,
    type ValueType,
} from './types';
import { parseWeekFileName, weekFileName, weekKey } from './week';

const DAY = 86_400_000;

export const META_FILE = 'meta.sqlite';

/** An open week file with its prepared statements */
interface WeekDb {
    key: string;
    fileName: string;
    db: SqliteDatabase;
    insertEvent: SqliteStatement;
    insertKeyframe: SqliteStatement;
    insertAggregate: SqliteStatement;
}

/** The rows of one write that belong to one week file */
interface WeekGroup {
    ts: number;
    events: RecordedEvent[];
    aggregates: AggregateRow[];
    keyframe?: Keyframe;
}

interface MetaStatements {
    insertDp: SqliteStatement;
    updateDp: SqliteStatement;
    setActive: SqliteStatement;
    insertSrc: SqliteStatement;
    getSrc: SqliteStatement;
}

export interface RetentionResult {
    /** Week files that were deleted completely */
    deletedFiles: string[];
    /** Rows deleted from the oldest remaining week file */
    trimmedRows: number;
}

/** Columns read from the event tables */
const COLUMNS = {
    ev: 'ts, val, sval, ack, src',
    agg5: 'ts, dp, min, max, avg, last',
} as const;

function rowToStored(row: Row): StoredRow {
    const ack = toNumber(row.ack);
    return {
        ts: toNumber(row.ts) ?? 0,
        val: toNumber(row.val),
        sval: toText(row.sval),
        ack: ack === null ? null : ack !== 0,
        src: toNumber(row.src),
    };
}

function rowToAggregate(row: Row): AggregateRow {
    return {
        ts: toNumber(row.ts) ?? 0,
        dp: toNumber(row.dp) ?? 0,
        min: toNumber(row.min) ?? 0,
        max: toNumber(row.max) ?? 0,
        avg: toNumber(row.avg) ?? 0,
        last: toNumber(row.last) ?? 0,
    };
}

function rowToDp(row: Row): DpInfo {
    return {
        id: toNumber(row.id) ?? 0,
        oid: toText(row.oid) ?? '',
        name: toText(row.name),
        room: toText(row.room),
        func: toText(row.func),
        role: toText(row.role),
        unit: toText(row.unit),
        devType: toText(row.devType),
        category: toText(row.category),
        cls: toNumber(row.cls) ?? DpClass.Discrete,
        type: (toText(row.type) ?? 'json') as ValueType,
        states: toText(row.states),
        firstSeen: toNumber(row.firstSeen) ?? 0,
        lastSeen: toNumber(row.lastSeen) ?? 0,
        active: toNumber(row.active) === 1,
    };
}

/**
 * The storage layer: `meta.sqlite` for master data and statistics, one `ev-YYYY-Www.sqlite` per
 * ISO week (UTC) for events, keyframes and aggregates. All calls are synchronous; a batch of
 * several thousand rows takes a few milliseconds.
 */
export class Storage {
    private meta: SqliteDatabase | null = null;
    private stmts: MetaStatements | null = null;
    private readonly weeks = new Map<string, WeekDb>();
    private readonly dpsByOid = new Map<string, DpInfo>();
    private readonly dpsById = new Map<number, DpInfo>();
    private readonly sources = new Map<string, number>();
    private readonly sourcesById = new Map<number, { from: string | null; user: string | null }>();

    public constructor(public readonly dataDir: string) {}

    /** Opens `meta.sqlite` and loads master data into memory */
    public open(): void {
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }
        this.meta = openDatabase(join(this.dataDir, META_FILE));
        initMetaSchema(this.meta);

        this.stmts = {
            insertDp: this.meta.prepare(
                `INSERT INTO dp (oid, name, room, func, role, unit, devType, category, cls, type, states, firstSeen, lastSeen, active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            ),
            updateDp: this.meta.prepare(
                `UPDATE dp SET name = ?, room = ?, func = ?, role = ?, unit = ?, devType = ?, category = ?, cls = ?, type = ?,
                 states = ?, lastSeen = ?, active = 1 WHERE id = ?`,
            ),
            setActive: this.meta.prepare('UPDATE dp SET active = ? WHERE id = ?'),
            insertSrc: this.meta.prepare('INSERT INTO src (fromId, userId, kind) VALUES (?, ?, ?)'),
            getSrc: this.meta.prepare('SELECT id FROM src WHERE fromId IS ? AND userId IS ?'),
        };

        for (const row of this.meta.prepare('SELECT * FROM dp').all()) {
            const dp = rowToDp(row);
            this.dpsByOid.set(dp.oid, dp);
            this.dpsById.set(dp.id, dp);
        }
        for (const row of this.meta.prepare('SELECT id, fromId, userId FROM src').all()) {
            const from = toText(row.fromId);
            const user = toText(row.userId);
            const id = toNumber(row.id) ?? 0;
            this.sources.set(`${from ?? ''}\n${user ?? ''}`, id);
            this.sourcesById.set(id, { from, user });
        }
    }

    /** Closes all files. Pending data must have been written before. */
    public close(): void {
        for (const week of this.weeks.values()) {
            week.db.close();
        }
        this.weeks.clear();
        this.meta?.close();
        this.meta = null;
        this.stmts = null;
    }

    private get metaDb(): SqliteDatabase {
        if (!this.meta) {
            throw new Error('Storage is not open');
        }
        return this.meta;
    }

    private get statements(): MetaStatements {
        if (!this.stmts) {
            throw new Error('Storage is not open');
        }
        return this.stmts;
    }

    // ---------------------------------------------------------------- master data

    public getDp(oid: string): DpInfo | undefined {
        return this.dpsByOid.get(oid);
    }

    public getDpById(id: number): DpInfo | undefined {
        return this.dpsById.get(id);
    }

    /** All datapoints that were ever recorded */
    public listDps(): DpInfo[] {
        return [...this.dpsById.values()];
    }

    /** Inserts or updates a datapoint and marks it as active */
    public upsertDp(def: DpDefinition, now: number = Date.now()): DpInfo {
        const existing = this.dpsByOid.get(def.oid);
        if (existing) {
            this.statements.updateDp.run(
                def.name,
                def.room,
                def.func,
                def.role,
                def.unit,
                def.devType,
                def.category,
                def.cls,
                def.type,
                def.states,
                now,
                existing.id,
            );
            Object.assign(existing, def, { lastSeen: now, active: true });
            return existing;
        }
        const result = this.statements.insertDp.run(
            def.oid,
            def.name,
            def.room,
            def.func,
            def.role,
            def.unit,
            def.devType,
            def.category,
            def.cls,
            def.type,
            def.states,
            now,
            now,
        );
        const dp: DpInfo = { ...def, id: Number(result.lastInsertRowid), firstSeen: now, lastSeen: now, active: true };
        this.dpsByOid.set(dp.oid, dp);
        this.dpsById.set(dp.id, dp);
        return dp;
    }

    /** Runs several changes of master data (e.g. `upsertDp` for a whole selection) in one transaction */
    public batchMeta<T>(fn: () => T): T {
        return transaction(this.metaDb, fn);
    }

    /** Marks all datapoints whose ID is not in `activeIds` as inactive. Their data is kept. */
    public deactivateAllExcept(activeIds: Set<number>): number {
        let count = 0;
        transaction(this.metaDb, () => {
            for (const dp of this.dpsById.values()) {
                if (dp.active && !activeIds.has(dp.id)) {
                    this.statements.setActive.run(0, dp.id);
                    dp.active = false;
                    count++;
                }
            }
        });
        return count;
    }

    /** Returns the ID of a source (`state.from` + `state.user`), creating it if needed */
    public getSourceId(from: string | undefined, user: string | undefined, kind: SourceKind): number {
        const key = `${from ?? ''}\n${user ?? ''}`;
        const cached = this.sources.get(key);
        if (cached !== undefined) {
            return cached;
        }
        let id = toNumber(this.statements.getSrc.get(from ?? null, user ?? null)?.id);
        if (id === null) {
            id = Number(this.statements.insertSrc.run(from ?? null, user ?? null, kind).lastInsertRowid);
        }
        this.sources.set(key, id);
        this.sourcesById.set(id, { from: from ?? null, user: user ?? null });
        return id;
    }

    // ---------------------------------------------------------------- week files

    private openWeek(ts: number): WeekDb {
        const key = weekKey(ts);
        let week = this.weeks.get(key);
        if (!week) {
            const fileName = weekFileName(ts);
            const db = openDatabase(join(this.dataDir, fileName));
            initEventsSchema(db, fileName);
            week = {
                key,
                fileName,
                db,
                insertEvent: db.prepare('INSERT INTO ev (ts, dp, val, sval, ack, src) VALUES (?, ?, ?, ?, ?, ?)'),
                insertKeyframe: db.prepare('INSERT OR REPLACE INTO keyframe (ts, dp, val, sval) VALUES (?, ?, ?, ?)'),
                // OR REPLACE: an interval written partially on unload is completed after a restart
                insertAggregate: db.prepare(
                    'INSERT OR REPLACE INTO agg5 (ts, dp, min, max, avg, last) VALUES (?, ?, ?, ?, ?, ?)',
                ),
            };
            this.weeks.set(key, week);
        }
        return week;
    }

    /** Closes week files that are not the current week and were not used by the last write */
    private closeIdleWeeks(keep: Set<string>): void {
        const current = weekKey(Date.now());
        for (const [key, week] of this.weeks) {
            if (key !== current && !keep.has(key)) {
                week.db.close();
                this.weeks.delete(key);
            }
        }
    }

    /**
     * Writes a batch of events, 5 minute aggregates and optionally a keyframe: one transaction per
     * affected week file (normally exactly one).
     */
    public write(events: RecordedEvent[], keyframe?: Keyframe, aggregates: AggregateRow[] = []): void {
        const byWeek = new Map<string, WeekGroup>();
        const groupOf = (ts: number): WeekGroup => {
            const key = weekKey(ts);
            let group = byWeek.get(key);
            if (!group) {
                group = { ts, events: [], aggregates: [] };
                byWeek.set(key, group);
            }
            return group;
        };
        for (const event of events) {
            groupOf(event.ts).events.push(event);
        }
        for (const row of aggregates) {
            groupOf(row.ts).aggregates.push(row);
        }
        if (keyframe?.rows.length) {
            groupOf(keyframe.ts).keyframe = keyframe;
        }

        for (const group of byWeek.values()) {
            const week = this.openWeek(group.ts);
            transaction(week.db, () => {
                for (const e of group.events) {
                    week.insertEvent.run(e.ts, e.dp, e.val, e.sval, e.ack ? 1 : 0, e.src);
                }
                for (const a of group.aggregates) {
                    week.insertAggregate.run(a.ts, a.dp, a.min, a.max, a.avg, a.last);
                }
                if (group.keyframe) {
                    const ts = group.keyframe.ts;
                    for (const row of group.keyframe.rows) {
                        week.insertKeyframe.run(ts, row.dp, row.val, row.sval);
                    }
                }
            });
        }
        this.closeIdleWeeks(new Set(byWeek.keys()));
    }

    /** All week files in the data directory, sorted by time */
    public listWeekFiles(): { fileName: string; key: string; start: number; end: number }[] {
        if (!existsSync(this.dataDir)) {
            return [];
        }
        return readdirSync(this.dataDir)
            .map(fileName => {
                const parsed = parseWeekFileName(fileName);
                return parsed ? { fileName, ...parsed } : null;
            })
            .filter(f => f !== null)
            .sort((a, b) => a.start - b.start);
    }

    /**
     * Calls `fn` for every week file that overlaps `[from, to)`. Files that are not open are opened
     * for the call and closed again.
     */
    public forEachWeek(from: number, to: number, fn: (db: SqliteDatabase) => void): void {
        for (const file of this.listWeekFiles()) {
            if (file.end > from && file.start < to) {
                this.withWeekFile(file, fn);
            }
        }
    }

    /** Calls `fn` with the database of a week file, opening and closing it if it is not open */
    private withWeekFile(file: { key: string; fileName: string }, fn: (db: SqliteDatabase) => void): void {
        const open = this.weeks.get(file.key);
        if (open) {
            fn(open.db);
            return;
        }
        const db = openDatabase(join(this.dataDir, file.fileName));
        try {
            fn(db);
        } finally {
            db.close();
        }
    }

    /** Number of events in `[from, to)` */
    public countEvents(from: number, to: number): number {
        let count = 0;
        this.forEachWeek(from, to, db => {
            count +=
                toNumber(db.prepare('SELECT COUNT(*) AS n FROM ev WHERE ts >= ? AND ts < ?').get(from, to)?.n) ?? 0;
        });
        return count;
    }

    /** Number of events per `dp.id` in `[from, to)` */
    public countEventsPerDp(from: number, to: number): Map<number, number> {
        const counts = new Map<number, number>();
        this.forEachWeek(from, to, db => {
            for (const row of db
                .prepare('SELECT dp, COUNT(*) AS n FROM ev WHERE ts >= ? AND ts < ? GROUP BY dp')
                .all(from, to)) {
                const dp = toNumber(row.dp) ?? 0;
                counts.set(dp, (counts.get(dp) || 0) + (toNumber(row.n) ?? 0));
            }
        });
        return counts;
    }

    // ---------------------------------------------------------------- reading

    /**
     * Calls `fn` for the week files that overlap `[from, to)`, oldest or newest first, as long as it
     * returns `true`.
     */
    private scanWeeks(from: number, to: number, newestFirst: boolean, fn: (db: SqliteDatabase) => boolean): void {
        const files = this.listWeekFiles().filter(f => f.end > from && f.start < to);
        if (newestFirst) {
            files.reverse();
        }
        for (const file of files) {
            let more = true;
            this.withWeekFile(file, db => {
                more = fn(db);
            });
            if (!more) {
                break;
            }
        }
    }

    /**
     * Rows of one datapoint in `[from, to)` of `ev` or `agg5`, sorted by time. With `limit` only the
     * oldest ones, or with `newest` the newest ones.
     */
    private readRange(
        table: 'ev' | 'agg5',
        dp: number,
        from: number,
        to: number,
        limit: number | undefined,
        newest: boolean,
    ): Row[] {
        const rows: Row[] = [];
        const order = newest ? 'DESC' : 'ASC';
        const sql = `SELECT ${COLUMNS[table]} FROM ${table} WHERE dp = ? AND ts >= ? AND ts < ? ORDER BY ts ${order}, rowid ${order}`;
        this.scanWeeks(from, to, newest, db => {
            const found = limit
                ? db.prepare(`${sql} LIMIT ?`).all(dp, from, to, limit - rows.length)
                : db.prepare(sql).all(dp, from, to);
            rows.push(...found);
            return !limit || rows.length < limit;
        });
        return newest ? rows.reverse() : rows;
    }

    /** The first row of `ev` or `agg5` of a datapoint at or after `ts` */
    private readFirstFrom(table: 'ev' | 'agg5', dp: number, ts: number): Row | null {
        let result: Row | null = null;
        const sql = `SELECT ${COLUMNS[table]} FROM ${table} WHERE dp = ? AND ts >= ? ORDER BY ts, rowid LIMIT 1`;
        this.scanWeeks(ts, Infinity, false, db => {
            result = db.prepare(sql).get(dp, ts) ?? null;
            return !result;
        });
        return result;
    }

    /** Events of one datapoint in `[from, to)`, sorted by time; see `readRange` for `limit` */
    public readEvents(dp: number, from: number, to: number, limit?: number, newest = false): StoredRow[] {
        return this.readRange('ev', dp, from, to, limit, newest).map(rowToStored);
    }

    /** The first event of a datapoint at or after `ts` */
    public readEventFrom(dp: number, ts: number): StoredRow | null {
        const row = this.readFirstFrom('ev', dp, ts);
        return row ? rowToStored(row) : null;
    }

    /**
     * The value of a datapoint before `ts`: its last event, or the hourly keyframe if that is later.
     * Thanks to the keyframes, a value that did not change for weeks is found in the week of `ts`.
     */
    public readValueBefore(dp: number, ts: number): StoredRow | null {
        let result: StoredRow | null = null;
        this.scanWeeks(0, ts, true, db => {
            const event = db
                .prepare(`SELECT ${COLUMNS.ev} FROM ev WHERE dp = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT 1`)
                .get(dp, ts);
            if (event) {
                result = rowToStored(event);
            }
            const keyframeTs = toNumber(db.prepare('SELECT MAX(ts) AS ts FROM keyframe WHERE ts < ?').get(ts)?.ts);
            if (keyframeTs !== null && (!result || keyframeTs > result.ts)) {
                const row = db.prepare('SELECT val, sval FROM keyframe WHERE ts = ? AND dp = ?').get(keyframeTs, dp);
                if (row) {
                    result = { ts: keyframeTs, val: toNumber(row.val), sval: toText(row.sval), ack: null, src: null };
                }
            }
            // a keyframe holds every datapoint that had a value: older files cannot know more
            return !result && keyframeTs === null;
        });
        return result;
    }

    /** 5 minute aggregates of one datapoint with a start in `[from, to)`; see `readRange` for `limit` */
    public readAggregates(dp: number, from: number, to: number, limit?: number, newest = false): AggregateRow[] {
        return this.readRange('agg5', dp, from, to, limit, newest).map(rowToAggregate);
    }

    /** The first 5 minute aggregate of a datapoint that starts at or after `ts` */
    public readAggregateFrom(dp: number, ts: number): AggregateRow | null {
        const row = this.readFirstFrom('agg5', dp, ts);
        return row ? rowToAggregate(row) : null;
    }

    /** The last 5 minute aggregate of a datapoint that starts before `ts` */
    public readAggregateBefore(dp: number, ts: number): AggregateRow | null {
        let result: AggregateRow | null = null;
        const sql = `SELECT ${COLUMNS.agg5} FROM agg5 WHERE dp = ? AND ts < ? ORDER BY ts DESC LIMIT 1`;
        this.scanWeeks(0, ts, true, db => {
            const row = db.prepare(sql).get(dp, ts);
            result = row ? rowToAggregate(row) : null;
            return !result;
        });
        return result;
    }

    // ---------------------------------------------------------------- rates

    /** The measured change rates by `dp.id` */
    public loadRates(): Map<number, RateInfo> {
        const rates = new Map<number, RateInfo>();
        for (const row of this.metaDb.prepare('SELECT dp, perMin, maxPerMin, high, ts FROM rate').all()) {
            rates.set(toNumber(row.dp) ?? 0, {
                perMin: toNumber(row.perMin) ?? 0,
                maxPerMin: toNumber(row.maxPerMin) ?? 0,
                high: toNumber(row.high) === 1,
                ts: toNumber(row.ts) ?? 0,
            });
        }
        return rates;
    }

    /** Stores measured change rates, in one transaction */
    public saveRates(rates: Map<number, RateInfo>): void {
        const db = this.metaDb;
        const upsert = db.prepare(
            'INSERT OR REPLACE INTO rate (dp, perMin, maxPerMin, high, ts) VALUES (?, ?, ?, ?, ?)',
        );
        transaction(db, () => {
            for (const [dp, rate] of rates) {
                upsert.run(dp, rate.perMin, rate.maxPerMin, rate.high ? 1 : 0, rate.ts);
            }
        });
    }

    /** `state.from` and `state.user` of a source ID */
    public getSource(id: number): { from: string | null; user: string | null } | undefined {
        return this.sourcesById.get(id);
    }

    /**
     * Deletes week files that lie completely before `now - days`, and trims the rows before that
     * point from the oldest remaining file, so that the retention is exact to the millisecond.
     */
    public retention(days: number, now: number = Date.now()): RetentionResult {
        const cutoff = now - days * DAY;
        const result: RetentionResult = { deletedFiles: [], trimmedRows: 0 };

        for (const file of this.listWeekFiles()) {
            if (file.end <= cutoff) {
                const open = this.weeks.get(file.key);
                if (open) {
                    open.db.close();
                    this.weeks.delete(file.key);
                }
                for (const suffix of ['', '-wal', '-shm']) {
                    const path = join(this.dataDir, file.fileName + suffix);
                    if (existsSync(path)) {
                        unlinkSync(path);
                    }
                }
                result.deletedFiles.push(file.fileName);
            } else if (file.start < cutoff) {
                this.withWeekFile(file, db => {
                    transaction(db, () => {
                        for (const table of ['ev', 'keyframe', 'agg5']) {
                            const r = db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff);
                            result.trimmedRows += Number(r.changes);
                        }
                    });
                });
            }
        }
        return result;
    }

    /** Size of all database files in bytes (including WAL files) */
    public sizeBytes(): number {
        if (!existsSync(this.dataDir)) {
            return 0;
        }
        let size = 0;
        for (const fileName of readdirSync(this.dataDir)) {
            if (fileName.startsWith('ev-') || fileName.startsWith('meta.sqlite')) {
                try {
                    size += statSync(join(this.dataDir, fileName)).size;
                } catch {
                    // deleted in the meantime
                }
            }
        }
        return size;
    }
}
