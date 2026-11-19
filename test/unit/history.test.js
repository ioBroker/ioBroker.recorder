'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { sendResponse } = require('@iobroker/aggregate');

const { parseHistoryRequest, readHistory, toTimestamp } = require('../../build/lib/history');
const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Wednesday of ISO week 47 (UTC)
const T0 = Date.UTC(2026, 10, 18, 12, 0);
const NOTHING_PENDING = { events: [], aggregates: [] };

function definition(oid, type = 'number', cls = DpClass.Continuous) {
    return { oid, name: oid, room: null, func: null, role: 'value', unit: null, devType: null, category: null, cls, type, states: null };
}

function options(message) {
    const parsed = parseHistoryRequest({ id: 'a.0.x', options: message }, T0 + DAY);
    assert.ok(!parsed.error, parsed.error);
    return parsed.options;
}

/** Calls `sendResponse` with a fake adapter and returns the answer */
function respond(id, opts, data) {
    let answer;
    const adapter = {
        log: { debug() {}, info() {}, warn() {}, error() {} },
        sendTo: (_from, _command, payload) => (answer = payload),
    };
    sendResponse(adapter, { from: 'test', command: 'getHistory', callback: {} }, id, opts, data, Date.now());
    return answer;
}

describe('getHistory options', () => {
    it('rejects invalid calls', () => {
        assert.ok(parseHistoryRequest({ id: 'a.0.x' }).error);
        assert.ok(parseHistoryRequest({ options: {} }).error);
        assert.ok(parseHistoryRequest({ id: '*', options: {} }).error);
        assert.ok(parseHistoryRequest({ id: 'a.0.x', options: { aggregate: 'median' } }).error);
        assert.ok(parseHistoryRequest({ id: 'a.0.x', options: { start: 'yesterday' } }).error);
        assert.ok(parseHistoryRequest({ id: 'a.0.x', options: { count: -1 } }).error);
    });

    it('uses the defaults of history and sql', () => {
        const avg = options({ start: T0, end: T0 + HOUR });
        assert.strictEqual(avg.aggregate, 'average');
        assert.strictEqual(avg.count, 500);
        assert.strictEqual(avg.limit, 2000);
        assert.strictEqual(avg.ignoreNull, false);

        const none = options({ start: T0, end: T0 + HOUR, aggregate: 'none', limit: 50 });
        assert.strictEqual(none.count, 50);

        const newest = options({ count: 10, aggregate: 'none' });
        assert.strictEqual(newest.returnNewestEntries, true);
        assert.strictEqual(newest.start, undefined);
        assert.strictEqual(newest.end, T0 + DAY + 5_000_000);
    });

    it('converts dates, swaps start and end and parses the flags', () => {
        const o = options({
            start: new Date(T0 + HOUR).toISOString(),
            end: String(T0),
            round: '2',
            ignoreNull: '0',
            ack: true,
            from: 1,
        });
        assert.strictEqual(o.start, T0);
        assert.strictEqual(o.end, T0 + HOUR);
        assert.strictEqual(o.round, 100);
        assert.strictEqual(o.ignoreNull, 0);
        assert.strictEqual(o.ack, true);
        assert.strictEqual(o.from, true);
        assert.strictEqual(toTimestamp('x'), undefined);
    });

    it('takes start and end from intervalBorders', () => {
        const o = options({ intervalBorders: [T0, T0 + HOUR, T0 + 2 * HOUR], aggregate: 'total', start: 1, end: 2 });
        assert.deepStrictEqual(o.intervalBorders, [T0, T0 + HOUR, T0 + 2 * HOUR]);
        assert.strictEqual(o.start, T0);
        assert.strictEqual(o.end, T0 + 2 * HOUR);
    });

    it('validates the parameters of the methods', () => {
        assert.strictEqual(options({ aggregate: 'percentile', percentile: 120 }).percentile, 50);
        assert.strictEqual(options({ aggregate: 'quantile', quantile: '0.9' }).quantile, 0.9);
        const integral = options({ aggregate: 'integral', integralUnit: 3600, integralInterpolation: 'linear' });
        assert.strictEqual(integral.integralUnit, 3600);
        assert.strictEqual(integral.integralInterpolation, 'linear');
    });
});

describe('getHistory data', () => {
    let dir;
    let storage;
    let temp;
    let src;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-history-'));
        storage = new Storage(dir);
        storage.open();
        temp = storage.upsertDp(definition('a.0.temp'));
        src = storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User);
        const ev = (ts, val, ack = true) => ({ ts, dp: temp.id, val, sval: null, ack, src });
        // the previous week, a keyframe at T0 - 1 h, and changes around T0
        storage.write([ev(T0 - 7 * DAY, 1)]);
        storage.write([], { ts: T0 - HOUR, rows: [{ dp: temp.id, val: 18, sval: null }] });
        storage.write([ev(T0 + 10 * MIN, 20), ev(T0 + 20 * MIN, 21, false), ev(T0 + 40 * MIN, 22), ev(T0 + 2 * HOUR, 25)]);
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns the changes with the values just before and after the range', () => {
        const o = options({ start: T0, end: T0 + HOUR, aggregate: 'none', ack: true, from: true });
        const data = readHistory(storage, temp, o, NOTHING_PENDING);
        assert.deepStrictEqual(
            data.map(e => [e.ts - T0, e.val]),
            [
                [-HOUR, 18], // from the keyframe: no change since the last week
                [10 * MIN, 20],
                [20 * MIN, 21],
                [40 * MIN, 22],
                [2 * HOUR, 25],
            ],
        );
        assert.strictEqual(data[2].ack, false);
        assert.strictEqual(data[1].from, 'system.adapter.vis-2.0');
        assert.strictEqual(data[1].user, 'system.user.admin');
        assert.ok(!('c' in data[1]), 'c only with comment');
    });

    it('returns the script of javascript with comment, as history does', () => {
        const script = storage.getSourceId(
            'system.adapter.javascript.0',
            undefined,
            SourceKind.Script,
            'script.js.common.Heating',
        );
        storage.write([{ ts: T0 + 30 * MIN, dp: temp.id, val: 23, sval: null, ack: false, src: script }]);
        const read = message =>
            readHistory(storage, temp, options({ start: T0, end: T0 + HOUR, aggregate: 'none', ...message }), NOTHING_PENDING)
                .filter(e => e.ts === T0 + 30 * MIN)[0];
        assert.strictEqual(read({ comment: true }).c, 'script.js.common.Heating');
        assert.ok(!('from' in read({ comment: true })), 'from only with from');
        assert.ok(!('c' in read({ from: true })), 'c only with comment');
        assert.strictEqual(read({ from: true, comment: true }).from, 'system.adapter.javascript.0');
    });

    it('finds the value before the range in an older week', () => {
        // the week of the start has no change and no keyframe before it
        const o = options({ start: T0 - DAY, end: T0 - 2 * HOUR, aggregate: 'none' });
        const data = readHistory(storage, temp, o, NOTHING_PENDING);
        assert.deepStrictEqual(
            data.map(e => [e.ts - T0, e.val]),
            [
                [-7 * DAY, 1],
                [10 * MIN, 20], // the next change; keyframes are no changes
            ],
        );
    });

    it('includes the values that are not written yet', () => {
        const pending = {
            events: [
                { ts: T0 + 30 * MIN, dp: temp.id, val: 30, sval: null, ack: true, src },
                { ts: T0 + 30 * MIN, dp: temp.id + 1, val: 99, sval: null, ack: true, src },
            ],
            aggregates: [],
        };
        const o = options({ start: T0, end: T0 + HOUR, aggregate: 'none', removeBorderValues: true });
        const values = readHistory(storage, temp, o, pending).map(e => e.val);
        assert.deepStrictEqual(values, [18, 20, 21, 30, 22, 25]);
    });

    it('returns the newest values without start', () => {
        const o = options({ count: 2, aggregate: 'none' });
        const answer = respond('a.0.temp', o, readHistory(storage, temp, o, NOTHING_PENDING));
        assert.deepStrictEqual(
            answer.result.map(e => e.val),
            [22, 25],
        );
    });

    it('aggregates with @iobroker/aggregate', () => {
        const o = options({ start: T0, end: T0 + HOUR, aggregate: 'max', count: 2, removeBorderValues: true });
        const answer = respond('a.0.temp', o, readHistory(storage, temp, o, NOTHING_PENDING));
        assert.deepStrictEqual(
            answer.result.map(e => e.val),
            [21, 22],
        );
    });

    it('returns booleans raw and as 0/1 for the aggregation', () => {
        const sw = storage.upsertDp(definition('a.0.switch', 'boolean', DpClass.Discrete));
        storage.write([
            { ts: T0 + MIN, dp: sw.id, val: 1, sval: null, ack: true, src },
            { ts: T0 + 2 * MIN, dp: sw.id, val: 0, sval: null, ack: true, src },
        ]);
        const raw = readHistory(storage, sw, options({ start: T0, end: T0 + HOUR, aggregate: 'none' }), NOTHING_PENDING);
        assert.deepStrictEqual(
            raw.map(e => e.val),
            [true, false],
        );
        const counted = readHistory(storage, sw, options({ start: T0, end: T0 + HOUR, aggregate: 'total' }), NOTHING_PENDING);
        assert.deepStrictEqual(
            counted.map(e => e.val),
            [1, 0],
        );
    });

    it('does not aggregate strings', () => {
        const text = storage.upsertDp(definition('a.0.text', 'string', DpClass.Discrete));
        storage.write([{ ts: T0 + MIN, dp: text.id, val: null, sval: 'open', ack: true, src }]);
        const o = options({ start: T0, end: T0 + HOUR });
        const data = readHistory(storage, text, o, NOTHING_PENDING);
        assert.strictEqual(o.aggregate, 'onchange');
        assert.deepStrictEqual(
            data.map(e => e.val),
            ['open'],
        );
    });

    it('answers datapoints of class "aggregated" from the 5 minute aggregates', () => {
        const power = storage.upsertDp(definition('a.0.power', 'number', DpClass.Aggregated));
        const row = (ts, min, max, avg) => ({ ts, dp: power.id, min, max, avg, last: avg });
        storage.write([], undefined, [row(T0, 100, 300, 200), row(T0 + 5 * MIN, 50, 150, 100), row(T0 + 10 * MIN, 0, 0, 0)]);
        const pending = { events: [], aggregates: [row(T0 + 10 * MIN, 10, 30, 20), row(T0 + 15 * MIN, 1, 3, 2)] };

        const none = readHistory(storage, power, options({ start: T0, end: T0 + 20 * MIN, aggregate: 'none' }), pending);
        assert.deepStrictEqual(
            none.map(e => [e.ts - T0, e.val]),
            [
                [2.5 * MIN, 200],
                [7.5 * MIN, 100],
                [12.5 * MIN, 20], // the pending interval replaces the partial one written on unload
                [17.5 * MIN, 2],
            ],
        );
        const max = readHistory(storage, power, options({ start: T0, end: T0 + 10 * MIN, aggregate: 'max' }), pending);
        assert.deepStrictEqual(
            max.map(e => e.val),
            [300, 150, 30],
        );
    });

    it('takes the value before the range of class "aggregated" from the keyframe if it is newer', () => {
        const forecast = storage.upsertDp(definition('a.0.forecast', 'number', DpClass.Aggregated));
        // one interval two days ago, then the value did not change: only the keyframes know it
        storage.write([], undefined, [{ ts: T0 - 2 * DAY, dp: forecast.id, min: 1, max: 2, avg: 1.5, last: 2 }]);
        storage.write([], { ts: T0 - 30 * MIN, rows: [{ dp: forecast.id, val: 2, sval: null }] });

        const o = options({ start: T0, end: T0 + HOUR, aggregate: 'none' });
        assert.deepStrictEqual(
            readHistory(storage, forecast, o, NOTHING_PENDING).map(e => [e.ts - T0, e.val]),
            [[-30 * MIN, 2]],
        );
        // the interval before the range is newer than the keyframe
        const older = options({ start: T0 - 2 * DAY + 10 * MIN, end: T0 - DAY, aggregate: 'none' });
        assert.deepStrictEqual(
            readHistory(storage, forecast, older, NOTHING_PENDING).map(e => [e.ts - T0, e.val]),
            [[-2 * DAY + 2.5 * MIN, 1.5]],
        );
    });

    it('takes the first keyframe in the range if the recording started within it', () => {
        // nothing before T0 + 5 min: the keyframe written at the start has the value
        const blinds = storage.upsertDp(definition('a.0.blinds'));
        const forecast = storage.upsertDp(definition('a.0.forecast', 'number', DpClass.Aggregated));
        storage.write([], {
            ts: T0 + 5 * MIN,
            rows: [
                { dp: blinds.id, val: 7, sval: null },
                { dp: forecast.id, val: 3, sval: null },
            ],
        });
        storage.write([{ ts: T0 + 30 * MIN, dp: blinds.id, val: 8, sval: null, ack: true, src }]);

        const o = () => options({ start: T0 - DAY, end: T0 + HOUR, aggregate: 'none' });
        assert.deepStrictEqual(
            readHistory(storage, blinds, o(), NOTHING_PENDING).map(e => [e.ts - T0, e.val]),
            [
                [5 * MIN, 7],
                [30 * MIN, 8],
            ],
        );
        assert.deepStrictEqual(
            readHistory(storage, forecast, o(), NOTHING_PENDING).map(e => [e.ts - T0, e.val]),
            [[5 * MIN, 3]],
        );
    });
});
