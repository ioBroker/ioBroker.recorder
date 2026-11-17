'use strict';

const assert = require('node:assert');

const { DpClass } = require('../../build/lib/types');
const { HourStats, ProfileBuilder, hourOfWeek } = require('../../build/lib/stats');
const {
    AnomalyTracker,
    DEFAULT_ANOMALY_SETTINGS,
    activeDurations,
    hasLevel,
    isRacing,
    longLimit,
    percentile,
    poolProfile,
    rareActivity,
    silentLimit,
    unusualValue,
} = require('../../build/lib/anomaly');

const MIN = 60_000;
const HOUR = 60 * MIN;
// local times: Monday 2026-11-16
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();

describe('anomaly detection: statistics and rules', () => {
    describe('HourStats', () => {
        it('collects time-weighted means, active time, changes, updates and gaps', () => {
            const start = at(16, 10);
            const stats = new HourStats(start);
            stats.init(1, 20, start - 5 * MIN, start - 2 * HOUR);
            stats.init(2, 0, start - 3 * HOUR, start - 3 * HOUR);
            // temperature: 20 for 30 min, then 22
            stats.update(1, start + 30 * MIN, 22, true);
            stats.update(1, start + 40 * MIN, 22, false);
            // window: open 10:15 to 10:45
            stats.update(2, start + 15 * MIN, 1, true);
            assert.strictEqual(stats.onSince(2), start + 15 * MIN);
            stats.update(2, start + 45 * MIN, 0, true);
            assert.strictEqual(stats.onSince(2), null);
            const rows = stats.close(start + HOUR);
            const temp = rows.find(r => r.dp === 1);
            assert.strictEqual(temp.avg, 21);
            assert.strictEqual(temp.min, 20);
            assert.strictEqual(temp.max, 22);
            assert.strictEqual(temp.last, 22);
            assert.strictEqual(temp.changes, 1);
            assert.strictEqual(temp.updates, 2);
            assert.strictEqual(temp.maxGap, 35 * MIN, 'from 9:55 to 10:30');
            assert.strictEqual(temp.how, hourOfWeek(start));
            const window = rows.find(r => r.dp === 2);
            assert.strictEqual(window.onSec, 30 * 60);
            assert.strictEqual(window.changes, 2);
            // the next hour starts with the last value
            const next = stats.close(start + 2 * HOUR);
            assert.deepStrictEqual(
                next.map(r => [r.dp, r.avg, r.changes, r.updates]),
                [
                    [1, 22, 0, 0],
                    [2, 0, 0, 0],
                ],
            );
            assert.strictEqual(stats.lastUpdate(1), start + 40 * MIN);
        });

        it('counts the hours of the week from Monday', () => {
            assert.strictEqual(hourOfWeek(at(16, 0)), 0);
            assert.strictEqual(hourOfWeek(at(17, 3)), 27);
            assert.strictEqual(hourOfWeek(at(22, 23)), 167);
        });

        it('builds the profile like the batch statistics (Welford) and the baseline from live hours', () => {
            const values = [20, 21.5, 19, 22, 20.5];
            const builder = new ProfileBuilder();
            values.forEach((avg, i) =>
                builder.add({
                    ts: at(16, 10) - i * 7 * 24 * HOUR,
                    dp: 1,
                    how: 10,
                    avg,
                    min: avg - 1,
                    max: avg + 1,
                    last: avg,
                    onSec: 0,
                    changes: i % 2,
                    updates: 6,
                    maxGap: (i + 1) * MIN,
                    // the two oldest weeks computed from the recording
                    bf: i >= 3,
                }),
            );
            builder.add({
                ts: at(16, 11),
                dp: 1,
                how: 11,
                avg: null,
                min: null,
                max: null,
                last: null,
                onSec: 0,
                changes: 0,
                updates: 1,
                maxGap: 0,
                bf: false,
            });
            const cell = builder.cell(1, 10);
            const mean = values.reduce((a, b) => a + b) / values.length;
            const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
            assert.strictEqual(cell.n, 5);
            assert.ok(Math.abs(cell.mean - mean) < 1e-9);
            assert.ok(Math.abs(cell.m2 / (cell.nVal - 1) - variance) < 1e-9);
            assert.strictEqual(cell.min, 18);
            assert.strictEqual(cell.max, 23);
            assert.ok(Math.abs(cell.pActive - 0.4) < 1e-9);
            assert.deepStrictEqual(builder.cell(1, 11), {
                n: 1,
                nVal: 0,
                mean: null,
                m2: 0,
                pActive: 0,
                avgChanges: 0,
                avgUpdates: 1,
                min: null,
                max: null,
            });
            assert.strictEqual(builder.cell(1, 12), null);
            assert.deepStrictEqual(
                [...builder.hour(10)].map(([dp]) => dp),
                [1],
            );
            assert.deepStrictEqual(builder.baselines().get(1), {
                dp: 1,
                since: at(16, 10) - 4 * 7 * 24 * HOUR,
                liveSince: at(16, 10) - 2 * 7 * 24 * HOUR,
                hours: 4,
                updates: 19,
                changes: 1,
                maxGap: 3 * MIN,
            });
        });
    });

    describe('rules', () => {
        const cell = extra => ({
            n: 3,
            nVal: 3,
            mean: 21,
            m2: 0.5,
            pActive: 1,
            avgChanges: 6,
            avgUpdates: 6,
            min: 20,
            max: 22,
            ...extra,
        });

        it('learns levels, not counters', () => {
            const dp = extra => ({
                cls: DpClass.Continuous,
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                ...extra,
            });
            assert.ok(hasLevel(dp()));
            assert.ok(hasLevel(dp({ cls: DpClass.Aggregated, role: 'value.power', unit: 'W' })));
            assert.ok(!hasLevel(dp({ role: 'value.energy', unit: 'kWh' })));
            assert.ok(!hasLevel(dp({ role: 'value', unit: 'kWh' })));
            assert.ok(!hasLevel(dp({ role: 'value.time' })));
            assert.ok(!hasLevel(dp({ cls: DpClass.Discrete })));
        });

        it('pools the hour of the week with its neighbours', () => {
            const cells = new Map([
                [9, cell({ mean: 20 })],
                [10, cell({ mean: 21 })],
                [11, cell({ mean: 22, min: 21, max: 23, pActive: 0 })],
                [12, cell({ mean: 99 })],
            ]);
            const profile = poolProfile(cells, 10);
            assert.strictEqual(profile.n, 9);
            assert.strictEqual(profile.mean, 21);
            assert.strictEqual(profile.min, 20);
            assert.strictEqual(profile.max, 23);
            assert.ok(Math.abs(profile.pWeek - 2 / 3) < 1e-9);
            // m2: 3 * 0.5 + 3 * (1 + 0 + 1) = 7.5 over 8
            assert.ok(Math.abs(profile.sd - Math.sqrt(7.5 / 8)) < 1e-9);
            // Sunday 23:00 has Monday 00:00 as neighbour
            assert.strictEqual(poolProfile(new Map([[0, cell()]]), 167).n, 3);
        });

        it('finds unusual values', () => {
            const profile = poolProfile(new Map([[10, cell({ n: 6, nVal: 6, m2: 2.5 })]]), 10);
            assert.strictEqual(unusualValue(21.8, profile, 3), null, 'within the range');
            assert.strictEqual(unusualValue(22.5, profile, 3), null, 'outside the range, but z < 3');
            assert.ok(unusualValue(30, profile, 3).z > 3);
            assert.ok(unusualValue(10, profile, 3).z < -3);
            assert.strictEqual(unusualValue(30, poolProfile(new Map([[10, cell()]]), 10), 3), null, 'too few hours');
        });

        it('finds rare activity', () => {
            const quiet = new Map();
            for (let day = 0; day < 7; day++) {
                for (const h of [2, 3, 4]) {
                    quiet.set(day * 24 + h, cell({ pActive: 0 }));
                }
            }
            assert.ok(rareActivity(poolProfile(quiet, 3), 0.02));
            const friday = new Map(quiet);
            friday.set(4 * 24 + 3, cell({ pActive: 1 }));
            assert.ok(!rareActivity(poolProfile(friday, 3), 0.02), 'usual at this hour on another day');
            const monday = new Map(quiet);
            monday.set(2, cell({ pActive: 1 / 3 }));
            assert.ok(!rareActivity(poolProfile(monday, 3), 0.02), 'usual in the hour before');
            assert.ok(!rareActivity(poolProfile(new Map([[3, cell({ pActive: 0 })]]), 3), 0.02), 'not learned');
        });

        it('knows when a datapoint is silent, open too long or racing', () => {
            const s = DEFAULT_ANOMALY_SETTINGS;
            const baseline = {
                dp: 1,
                since: 0,
                hours: 100,
                updates: 600,
                changes: 300,
                maxGap: 30 * MIN,
                onP95: 0,
                onCount: 0,
            };
            assert.strictEqual(silentLimit(baseline, s), 6 * HOUR);
            assert.strictEqual(silentLimit({ ...baseline, maxGap: 8 * HOUR }, s), 12 * HOUR);
            assert.strictEqual(silentLimit({ ...baseline, updates: 10 }, s), null, 'reports seldom');
            assert.strictEqual(longLimit(baseline, s), null);
            assert.strictEqual(longLimit({ ...baseline, onCount: 10, onP95: 40 * MIN }, s), 60 * MIN);
            assert.strictEqual(longLimit({ ...baseline, onCount: 10, onP95: 5 * MIN }, s), 30 * MIN);
            // usually 3 changes per hour
            assert.ok(!isRacing(59, baseline, 10), 'at least one change per minute');
            assert.ok(isRacing(60, baseline, 10));
            assert.ok(!isRacing(60, baseline, 30));
            assert.ok(isRacing(60, { ...baseline, changes: 0 }, 10));
        });

        it('measures the durations of the active state', () => {
            const events = [
                { ts: 0, val: 1 },
                { ts: 10, val: 1 },
                { ts: 30, val: 0 },
                { ts: 100, val: 2 },
                { ts: 160, val: 0 },
                { ts: 200, val: 1 },
            ];
            assert.deepStrictEqual(activeDurations(events, 0), [30, 60]);
            assert.deepStrictEqual(activeDurations(events.slice(2), 1), [60]);
            assert.strictEqual(percentile([5, 1, 4, 2, 3], 0.95), 5);
            assert.strictEqual(percentile([5, 1, 4, 2, 3], 0.5), 3);
            assert.strictEqual(percentile([], 0.95), 0);
        });
    });

    describe('AnomalyTracker', () => {
        let store;
        let tracker;
        const describe1 = () => ({ text: 'something', val: 1 });

        beforeEach(() => {
            store = {
                rows: [],
                insertAnomaly(a) {
                    this.rows.push({ ...a });
                    return this.rows.length;
                },
                updateAnomaly(id, endTs, ackTs) {
                    Object.assign(this.rows[id - 1], { endTs, ackTs });
                },
            };
            tracker = new AnomalyTracker(store, 12 * HOUR);
        });

        it('raises a condition after its duration and ends it', () => {
            const t = at(16, 10);
            assert.strictEqual(tracker.condition(1, 'cold', true, t, 30 * MIN, describe1), null);
            assert.strictEqual(tracker.condition(1, 'cold', true, t + 29 * MIN, 30 * MIN, describe1), null);
            const anomaly = tracker.condition(1, 'cold', true, t + 30 * MIN, 30 * MIN, describe1);
            assert.strictEqual(anomaly.id, 1);
            assert.strictEqual(tracker.condition(1, 'cold', true, t + 40 * MIN, 30 * MIN, describe1), null, 'once');
            assert.strictEqual(tracker.list().length, 1);
            tracker.condition(1, 'cold', false, t + 50 * MIN, 30 * MIN, describe1);
            assert.strictEqual(tracker.list().length, 0);
            assert.strictEqual(store.rows[0].endTs, t + 50 * MIN);
            // quiet time
            tracker.condition(1, 'cold', true, t + HOUR, 0, describe1);
            assert.strictEqual(tracker.list().length, 0);
            tracker.condition(1, 'cold', true, t + 13 * HOUR, 0, describe1);
            assert.strictEqual(tracker.list().length, 1);
        });

        it('does not raise an acknowledged condition again before it is over', () => {
            const t = at(16, 10);
            tracker.quiet = 0;
            tracker.condition(1, 'silent', true, t, 0, describe1);
            assert.strictEqual(tracker.ack(null, t + MIN), 1);
            assert.strictEqual(tracker.list().length, 0);
            assert.strictEqual(tracker.condition(1, 'silent', true, t + 2 * MIN, 0, describe1), null);
            tracker.condition(1, 'silent', false, t + 3 * MIN, 0, describe1);
            assert.ok(tracker.condition(1, 'silent', true, t + 4 * MIN, 0, describe1));
        });

        it('keeps an event open until it is acknowledged or old', () => {
            const t = at(16, 3);
            assert.ok(tracker.event(2, 'rare', t, describe1));
            assert.strictEqual(tracker.event(2, 'rare', t + MIN, describe1), null);
            tracker.expire(t + 11 * HOUR);
            assert.strictEqual(tracker.list().length, 1);
            tracker.expire(t + 12 * HOUR);
            assert.strictEqual(tracker.list().length, 0);
            assert.ok(tracker.event(3, 'racing', t, describe1));
            assert.strictEqual(tracker.ack(store.rows.length, t + MIN), 1);
            assert.strictEqual(store.rows.at(-1).endTs, t + MIN);
            assert.strictEqual(tracker.list().length, 0);
        });

        it('restores the quiet time after a restart', () => {
            const t = at(16, 3);
            tracker.restore(
                [],
                [{ id: 7, dp: 2, rule: 'rare', ts: t - HOUR, endTs: null, ackTs: null, val: 1, text: '' }],
            );
            assert.strictEqual(tracker.event(2, 'rare', t, describe1), null);
            assert.ok(tracker.event(2, 'rare', t + 11 * HOUR, describe1));
        });
    });
});
