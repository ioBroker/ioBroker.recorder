'use strict';

const assert = require('node:assert');
const { Aggregator, AGG_INTERVAL } = require('../../build/lib/aggregator');

describe('aggregator', () => {
    const t0 = Date.UTC(2026, 10, 17, 12, 0);

    it('aggregates values of one interval', () => {
        const agg = new Aggregator();
        agg.add(1, t0 + 1000, 10);
        agg.add(1, t0 + 2000, 30);
        agg.add(1, t0 + 3000, 20);
        assert.deepStrictEqual(agg.takeClosed(t0 + 10_000), [], 'the interval is still running');
        assert.deepStrictEqual(agg.takeClosed(t0 + AGG_INTERVAL), [{ ts: t0, dp: 1, min: 10, max: 30, avg: 20, last: 20 }]);
        assert.deepStrictEqual(agg.takeAll(), []);
    });

    it('closes an interval when a value of the next one arrives', () => {
        const agg = new Aggregator();
        agg.add(1, t0, 5);
        agg.add(1, t0 + AGG_INTERVAL + 1, 7);
        agg.add(1, t0 + 10, 99); // late value of a closed interval
        const rows = agg.takeClosed(t0 + AGG_INTERVAL + 2);
        assert.deepStrictEqual(rows, [{ ts: t0, dp: 1, min: 5, max: 5, avg: 5, last: 5 }]);
        assert.deepStrictEqual(agg.takeAll(), [
            { ts: t0 + AGG_INTERVAL, dp: 1, min: 7, max: 7, avg: 7, last: 7 },
        ]);
    });

    it('puts rows back after a failed write', () => {
        const agg = new Aggregator();
        agg.add(2, t0, 1);
        const rows = agg.takeAll();
        agg.restore(rows);
        assert.deepStrictEqual(agg.takeClosed(t0), rows);
    });
});
