import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

export type { SQLInputValue, SQLOutputValue };
export type Row = Record<string, SQLOutputValue>;

/**
 * The subset of a synchronous SQLite driver that the storage uses. `node:sqlite` implements it
 * directly; `better-sqlite3` has the same shape, so it can be plugged in as a fallback later.
 */
export interface SqliteStatement {
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SQLInputValue[]): Row | undefined;
    all(...params: SQLInputValue[]): Row[];
}

export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    close(): void;
}

type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

let databaseSync: DatabaseSyncConstructor | null = null;

/**
 * Loads `node:sqlite`. The module prints "ExperimentalWarning: SQLite is an experimental feature"
 * on the first `require`, which ioBroker would show as an error in the log. Only this one warning
 * is suppressed, and only while the module is loaded.
 */
function loadNodeSqlite(): DatabaseSyncConstructor {
    if (!databaseSync) {
        const originalEmitWarning = process.emitWarning;
        process.emitWarning = (warning: string | Error, ...args: unknown[]): void => {
            const text = typeof warning === 'string' ? warning : warning?.message;
            if (typeof text === 'string' && text.includes('SQLite')) {
                return;
            }
            (originalEmitWarning as (warning: string | Error, ...args: unknown[]) => void).call(
                process,
                warning,
                ...args,
            );
        };
        try {
            const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
            databaseSync = sqlite.DatabaseSync;
        } finally {
            process.emitWarning = originalEmitWarning;
        }
    }
    return databaseSync;
}

class NodeSqliteStatement implements SqliteStatement {
    public constructor(private readonly statement: StatementSync) {}

    public run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
        return this.statement.run(...params);
    }

    public get(...params: SQLInputValue[]): Row | undefined {
        return this.statement.get(...params);
    }

    public all(...params: SQLInputValue[]): Row[] {
        return this.statement.all(...params);
    }
}

class NodeSqliteDatabase implements SqliteDatabase {
    private readonly db: DatabaseSync;

    public constructor(path: string) {
        const DatabaseSyncClass = loadNodeSqlite();
        this.db = new DatabaseSyncClass(path);
    }

    public exec(sql: string): void {
        this.db.exec(sql);
    }

    public prepare(sql: string): SqliteStatement {
        return new NodeSqliteStatement(this.db.prepare(sql));
    }

    public close(): void {
        if (this.db.isOpen) {
            this.db.close();
        }
    }
}

/** Name of the driver, for the log */
export const DRIVER_NAME = 'node:sqlite';

/**
 * Opens (and creates, if missing) a database file with the settings that are used for all files
 * of this adapter: WAL journal and `synchronous = NORMAL`, which is crash safe and spares SD cards.
 * The WAL is checkpointed every 256 pages (1 MB) and truncated to 1 MB afterward; with the
 * defaults it stays at 4 MB per open file, which would distort `info.dbSize`.
 */
export function openDatabase(path: string): SqliteDatabase {
    const db = new NodeSqliteDatabase(path);
    db.exec(
        [
            'PRAGMA journal_mode = WAL',
            'PRAGMA synchronous = NORMAL',
            'PRAGMA temp_store = MEMORY',
            'PRAGMA wal_autocheckpoint = 256',
            'PRAGMA journal_size_limit = 1048576',
        ].join('; '),
    );
    return db;
}

/** Runs `fn` inside one transaction */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // the original error is more important
        }
        throw e;
    }
}

/** Reads a column as number (SQLite returns `bigint` only for values beyond 2^53) */
export function toNumber(value: SQLOutputValue | undefined): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'string') {
        const n = Number(value);
        return isNaN(n) ? null : n;
    }
    return null;
}

/** Reads a column as string */
export function toText(value: SQLOutputValue | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    return typeof value === 'string' ? value : String(value);
}
