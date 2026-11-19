'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync, existsSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');
const { WEEK } = require('../../build/lib/week');

const DAY = 86_400_000;

function definition(oid, type = 'number') {
    return {
        oid,
        name: oid,
        room: null,
        func: null,
        role: 'value',
        unit: null,
        devType: null,
        category: null,
        cls: type === 'number' ? DpClass.Continuous : DpClass.Discrete,
        type,
        states: null,
    };
}

describe('storage', () => {
    let dir;
    let storage;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-test-'));
        storage = new Storage(dir);
        storage.open();
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('stores the measured rates', () => {
        const a = storage.upsertDp(definition('a.0.power'));
        storage.saveRates(new Map([[a.id, { perMin: 12.5, maxPerMin: 20, high: true, ts: 1000 }]]));
        storage.close();
        storage = new Storage(dir);
        storage.open();
        assert.deepStrictEqual(storage.loadRates().get(a.id), { perMin: 12.5, maxPerMin: 20, high: true, ts: 1000 });
    });

    it('migrates meta.sqlite from version 1', () => {
        const a = storage.upsertDp(definition('a.0.temp'));
        storage.close();
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(join(dir, 'meta.sqlite'));
        db.exec('DROP TABLE rate; PRAGMA user_version = 1;');
        db.close();

        storage = new Storage(dir);
        storage.open();
        assert.strictEqual(storage.getDp('a.0.temp').id, a.id, 'the data is kept');
        assert.strictEqual(storage.loadRates().size, 0, 'the table exists again');
    });

    it('keeps datapoint IDs and sources across restarts', () => {
        const a = storage.upsertDp(definition('a.0.temp'));
        const b = storage.upsertDp(definition('a.0.switch', 'boolean'));
        assert.notStrictEqual(a.id, b.id);
        const src1 = storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User);
        const src2 = storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User);
        const src3 = storage.getSourceId(undefined, undefined, SourceKind.System);
        assert.strictEqual(src1, src2);
        assert.notStrictEqual(src1, src3);

        storage.close();
        storage = new Storage(dir);
        storage.open();
        assert.strictEqual(storage.getDp('a.0.temp').id, a.id);
        assert.strictEqual(storage.getDp('a.0.switch').type, 'boolean');
        assert.strictEqual(storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User), src1);
        // an update keeps the ID
        assert.strictEqual(storage.upsertDp({ ...definition('a.0.temp'), unit: '°C' }).id, a.id);
        assert.strictEqual(storage.getDp('a.0.temp').unit, '°C');
    });

    it('keeps the script of javascript (state.c) as part of the source', () => {
        const from = 'system.adapter.javascript.0';
        const light = storage.getSourceId(from, undefined, SourceKind.Script, 'script.js.common.Light');
        const blinds = storage.getSourceId(from, undefined, SourceKind.Script, 'script.js.common.Blinds');
        const plain = storage.getSourceId(from, undefined, SourceKind.Script);
        assert.strictEqual(new Set([light, blinds, plain]).size, 3, 'one source per script');
        assert.strictEqual(storage.getSourceId(from, undefined, SourceKind.Script, 'script.js.common.Light'), light);
        assert.strictEqual(storage.getSource(light).comment, 'script.js.common.Light');
        assert.strictEqual(storage.getSource(plain).comment, null);

        storage.close();
        storage = new Storage(dir);
        storage.open();
        assert.strictEqual(storage.getSource(blinds).comment, 'script.js.common.Blinds');
        assert.strictEqual(storage.getSourceId(from, undefined, SourceKind.Script, 'script.js.common.Blinds'), blinds);
        assert.deepStrictEqual(storage.sourceIdsOfKinds(new Set([SourceKind.Script])).sort(), [light, blinds, plain].sort());
    });

    it('migrates the sources of version 5 (without comment)', () => {
        const old = storage.getSourceId('system.adapter.javascript.0', undefined, SourceKind.Script);
        storage.close();
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(join(dir, 'meta.sqlite'));
        // the table src as version 5 had it
        db.exec(`DROP INDEX src_from_user_comment;
            ALTER TABLE src DROP COLUMN comment;
            CREATE UNIQUE INDEX src_from_user ON src(fromId, userId);
            PRAGMA user_version = 5;`);
        db.close();

        storage = new Storage(dir);
        storage.open();
        assert.strictEqual(storage.getSource(old).comment, null, 'the old source is kept');
        assert.strictEqual(storage.getSourceId('system.adapter.javascript.0', undefined, SourceKind.Script), old);
        const script = storage.getSourceId('system.adapter.javascript.0', undefined, SourceKind.Script, 'script.js.a');
        assert.notStrictEqual(script, old, 'the same from and user with a script is a new source');
    });

    it('marks datapoints inactive without deleting them', () => {
        const a = storage.upsertDp(definition('a.0.x'));
        const b = storage.upsertDp(definition('a.0.y'));
        assert.strictEqual(storage.deactivateAllExcept(new Set([a.id])), 1);
        assert.strictEqual(storage.getDp('a.0.y').active, false);
        storage.upsertDp(definition('a.0.y'));
        assert.strictEqual(storage.getDpById(b.id).active, true);
    });

    it('writes events into the file of their week', () => {
        const dp = storage.upsertDp(definition('a.0.temp'));
        const monday = Date.UTC(2026, 10, 16);
        const events = [
            { ts: monday - 1000, dp: dp.id, val: 1, sval: null, ack: true, src: null }, // previous week
            { ts: monday + 1000, dp: dp.id, val: 2, sval: null, ack: true, src: null },
            { ts: monday + 2000, dp: dp.id, val: null, sval: 'x', ack: false, src: 1 },
        ];
        storage.write(events, { ts: monday + 3000, rows: [{ dp: dp.id, val: null, sval: 'x' }] });

        const files = storage.listWeekFiles().map(f => f.fileName);
        assert.deepStrictEqual(files, ['ev-2026-W46.sqlite', 'ev-2026-W47.sqlite']);
        assert.strictEqual(storage.countEvents(monday - WEEK, monday + WEEK), 3);
        assert.strictEqual(storage.countEvents(monday, monday + WEEK), 2);

        let keyframes = 0;
        storage.forEachWeek(monday, monday + WEEK, db => {
            keyframes += Number(db.prepare('SELECT COUNT(*) AS n FROM keyframe').get().n);
        });
        assert.strictEqual(keyframes, 1);
        assert.ok(storage.sizeBytes() > 0);
    });

    it('deletes whole weeks and trims the oldest remaining week', () => {
        const dp = storage.upsertDp(definition('a.0.temp'));
        const now = Date.UTC(2026, 10, 18, 12); // Wednesday
        const events = [];
        for (let day = 0; day < 40; day++) {
            events.push({ ts: now - day * DAY, dp: dp.id, val: day, sval: null, ack: true, src: null });
        }
        storage.write(events);
        const before = storage.listWeekFiles().length;
        assert.ok(before >= 6);

        const result = storage.retention(14, now);
        assert.ok(result.deletedFiles.length > 0);
        for (const file of result.deletedFiles) {
            assert.ok(!existsSync(join(dir, file)), `${file} must be deleted`);
        }
        assert.ok(result.trimmedRows > 0);
        // exactly the last 14 days (plus the current one) remain
        assert.strictEqual(storage.countEvents(0, now + 1), 15);
        assert.ok(!readdirSync(dir).some(f => f.endsWith('-wal') && !existsSync(join(dir, f.replace(/-wal$/, '')))));
    });
});

describe('sourceComment', () => {
    const { sourceComment, classifySource } = require('../../build/lib/source');

    it('keeps state.c of automations only', () => {
        const kind = classifySource('system.adapter.javascript.0');
        assert.strictEqual(kind, SourceKind.Script);
        assert.strictEqual(sourceComment('script.js.common.Light', kind), 'script.js.common.Light');
        assert.strictEqual(sourceComment('  script.js.x  ', kind), 'script.js.x');
        assert.strictEqual(sourceComment('', kind), undefined);
        assert.strictEqual(sourceComment(undefined, kind), undefined);
        assert.strictEqual(sourceComment(42, kind), undefined);
        assert.strictEqual(sourceComment('x'.repeat(300), kind).length, 200);
        // other adapters may write any text, which would give a source per change
        assert.strictEqual(sourceComment('changed at 12:00', classifySource('system.adapter.hue.0')), undefined);
        assert.strictEqual(sourceComment('by Anna', classifySource('system.adapter.admin.0')), undefined);
    });
});
