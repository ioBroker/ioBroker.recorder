'use strict';

const assert = require('node:assert');
const { isoWeek, weekKey, weekStart, weekStartOf, weekFileName, parseWeekFileName, WEEK } = require('../../build/lib/week');

describe('week', () => {
    it('computes ISO weeks', () => {
        assert.deepStrictEqual(isoWeek(Date.UTC(2026, 10, 17, 12)), { year: 2026, week: 47 });
        // January 3rd 2021 belongs to the last week of 2020
        assert.deepStrictEqual(isoWeek(Date.UTC(2021, 0, 3)), { year: 2020, week: 53 });
        // December 30th 2024 belongs to the first week of 2025
        assert.deepStrictEqual(isoWeek(Date.UTC(2024, 11, 30)), { year: 2025, week: 1 });
        assert.strictEqual(weekKey(Date.UTC(2026, 0, 1)), '2026-W01');
    });

    it('starts weeks on Monday 00:00 UTC', () => {
        const ts = Date.UTC(2026, 10, 17, 12, 34);
        const start = weekStart(ts);
        assert.strictEqual(start, Date.UTC(2026, 10, 16));
        assert.strictEqual(new Date(start).getUTCDay(), 1);
        // Sunday 23:59 still belongs to the week that started on Monday
        assert.strictEqual(weekStart(Date.UTC(2026, 10, 22, 23, 59)), start);
        assert.strictEqual(weekStart(Date.UTC(2026, 10, 23)), start + WEEK);
    });

    it('converts file names in both directions', () => {
        const ts = Date.UTC(2026, 10, 17, 12);
        assert.strictEqual(weekFileName(ts), 'ev-2026-W47.sqlite');
        const parsed = parseWeekFileName('ev-2026-W47.sqlite');
        assert.deepStrictEqual(parsed, { key: '2026-W47', start: weekStart(ts), end: weekStart(ts) + WEEK });
        assert.strictEqual(parseWeekFileName('meta.sqlite'), null);
        assert.strictEqual(parseWeekFileName('ev-2026-W47.sqlite-wal'), null);
    });

    it('finds the start of every week of a year', () => {
        for (const year of [2020, 2025, 2026, 2027]) {
            for (let week = 1; week <= 52; week++) {
                const start = weekStartOf(year, week);
                assert.deepStrictEqual(isoWeek(start), { year, week });
                assert.deepStrictEqual(isoWeek(start - 1), week === 1 ? isoWeek(start - 1) : { year, week: week - 1 });
            }
        }
    });
});
