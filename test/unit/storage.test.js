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
