import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
    type RecordedEvent,
    type SourceKind,
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
            this.sources.set(`${toText(row.fromId) ?? ''}\n${toText(row.userId) ?? ''}`, toNumber(row.id) ?? 0);
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
     * Writes a batch of events and optionally a keyframe: one transaction per affected week file
     * (normally exactly one).
     */
    public write(events: RecordedEvent[], keyframe?: Keyframe): void {
        const byWeek = new Map<string, { ts: number; events: RecordedEvent[]; keyframe?: Keyframe }>();
        for (const event of events) {
            const key = weekKey(event.ts);
            let group = byWeek.get(key);
            if (!group) {
                group = { ts: event.ts, events: [] };
                byWeek.set(key, group);
            }
            group.events.push(event);
        }
        if (keyframe?.rows.length) {
            const key = weekKey(keyframe.ts);
            let group = byWeek.get(key);
            if (!group) {
                group = { ts: keyframe.ts, events: [] };
                byWeek.set(key, group);
            }
            group.keyframe = keyframe;
        }

        for (const group of byWeek.values()) {
            const week = this.openWeek(group.ts);
            transaction(week.db, () => {
                for (const e of group.events) {
                    week.insertEvent.run(e.ts, e.dp, e.val, e.sval, e.ack ? 1 : 0, e.src);
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
