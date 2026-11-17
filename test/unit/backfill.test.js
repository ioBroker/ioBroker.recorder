'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');
const { backfillRange, backfillStatistics } = require('../../build/lib/backfill');
const { DEFAULT_ANOMALY_SETTINGS, ratesLearned } = require('../../build/lib/anomaly');
const { AnomalyDetector } = require('../../build/lib/detector');
const { HourStats, ProfileBuilder } = require('../../build/lib/stats');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// local times, Monday 2026-11-09 to Thursday 2026-11-12
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const pause = () => Promise.resolve();

function definition(oid, extra) {
    return {
        oid,
        name: oid,
        room: null,
        func: null,
        role: 'state',
        unit: null,
        devType: null,
        category: null,
        cls: DpClass.Discrete,
        type: 'boolean',
        states: null,
        ...extra,
    };
}

describe('anomaly detection: statistics from the recording', () => {
    let dir;
    let storage;
    let window;
    let temp;
    let power;
    let removed;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-backfill-'));
        storage = new Storage(dir);
        storage.open();
        window = storage.upsertDp(definition('a.0.window', { category: 'windowsDoors' }));
        temp = storage.upsertDp(definition('a.0.temp', { type: 'number', cls: DpClass.Continuous }));
        power = storage.upsertDp(definition('a.0.power', { type: 'number', cls: DpClass.Aggregated }));
        removed = storage.upsertDp(definition('a.0.removed'));
        const src = storage.getSourceId('system.adapter.a.0', undefined, SourceKind.Adapter);
        const values = { [window.id]: 0, [temp.id]: 20, [power.id]: 100, [removed.id]: 1 };
        const ev = (ts, dp, val) => {
            values[dp] = val;
            return { ts, dp, val, sval: null, ack: true, src };
        };
        const keyframe = ts => ({
            ts,
            rows: Object.entries(values)
                .filter(([dp]) => Number(dp) !== removed.id || ts < at(9, 18))
                // the value cache holds changes within the dead band that were not stored
                .map(([dp, val]) => ({
                    dp: Number(dp),
                    val: Number(dp) === temp.id && ts > at(9, 15) && ts < at(9, 16) ? val + 0.05 : val,
                    sval: null,
                })),
        });

        // recording from Monday 09:20; the instance did not run from Tuesday 20:00 to Wednesday 02:30
        const down = [at(10, 20, 1), at(11, 2, 30)];
        const changes = [];
        for (let day = 9; day <= 11; day++) {
            changes.push([at(day, 10), window.id, 1], [at(day, 10, 30), window.id, 0]);
        }
        changes.push([at(9, 12), temp.id, 22], [at(10, 0), temp.id, 21]);
        changes.sort((a, b) => a[0] - b[0]);

        storage.write([], keyframe(at(9, 9, 20)));
        let next = 0;
        const recordUntil = until => {
            const events = [];
            while (next < changes.length && changes[next][0] < until) {
                const [time, dp, val] = changes[next++];
                if (time < down[0] || time >= down[1]) {
                    events.push(ev(time, dp, val));
                }
            }
            storage.write(events);
        };
        for (let ts = at(9, 10); ts < at(12, 0); ts += HOUR) {
            // a change at the full hour is in the keyframe two milliseconds later
            recordUntil(ts + 2);
            if (ts >= at(11, 2) && ts < at(11, 3)) {
                // the window was opened while the instance was not running
                values[window.id] = 1;
                storage.write([], keyframe(down[1]));
            }
            if (ts < down[0] || ts >= down[1]) {
                storage.write([], keyframe(ts + 2));
            }
            recordUntil(ts + HOUR);
        }
        // the power meter: one hour of 5 minute aggregates
        const aggs = [];
        for (let i = 0; i < 12; i++) {
            aggs.push({ ts: at(9, 13, i * 5), dp: power.id, min: 50, max: i === 3 ? 900 : 500, avg: 100, last: 100 });
        }
        storage.write([], undefined, aggs);
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const row = (dp, ts) => storage.readStatHours(dp, ts, ts + 1)[0];

    it('computes the hours from the start of the recording to the first live hour', async () => {
        const range = backfillRange(storage, at(12, 0), at(12, 0, 10), 56);
        assert.deepStrictEqual(range, { from: at(9, 10), to: at(12, 0) });
        const result = await backfillStatistics(storage, range, pause, () => false);
        // 62 hours, of them 5 without the instance running (21:00 to 02:00)
        assert.strictEqual(result.hours, 57);
        assert.strictEqual(row(temp.id, at(10, 22)), undefined);
        assert.strictEqual(row(temp.id, at(11, 1)), undefined);
        assert.ok(row(temp.id, at(10, 20)));

        const open = row(window.id, at(9, 10));
        assert.strictEqual(open.onSec, 1800);
        assert.strictEqual(open.changes, 2);
        assert.strictEqual(open.max, 1);
        assert.strictEqual(row(window.id, at(9, 11)).changes, 0);
        // opened while the instance was not running: open from the keyframe at 02:30 on
        assert.strictEqual(row(window.id, at(11, 2)).onSec, 1800);

        assert.strictEqual(row(temp.id, at(9, 11)).avg, 20);
        assert.strictEqual(row(temp.id, at(9, 12)).avg, 22);
        assert.strictEqual(row(temp.id, at(10, 0)).avg, 21);
        // an hourly keyframe is no change: the events are the truth
        assert.deepStrictEqual([row(temp.id, at(9, 15)).avg, row(temp.id, at(9, 15)).changes], [22, 0]);

        // the power: minimum and maximum of all samples, not of the means
        const meter = row(power.id, at(9, 13));
        assert.deepStrictEqual([meter.min, meter.max, meter.avg], [50, 900, 100]);

        // removed from the selection at 18:00
        assert.strictEqual(storage.readStatHours(removed.id, 0, at(12, 0)).length, 8);

        // done: nothing is computed twice
        assert.strictEqual(backfillRange(storage, at(12, 0), at(12, 0, 10), 56), null);
        assert.deepStrictEqual(storage.statHourBounds(), {
            first: at(9, 10),
            firstLive: null,
            lastBackfill: at(11, 23),
        });
    });

    it('continues where an interrupted run stopped', async () => {
        const range = backfillRange(storage, at(12, 0), at(12, 0, 10), 56);
        assert.strictEqual(await backfillStatistics(storage, range, pause, () => true), null);
        const rest = backfillRange(storage, at(12, 0), at(12, 0, 10), 56);
        // the first step of 2 hours is stored
        assert.deepStrictEqual(rest, { from: at(9, 12), to: at(12, 0) });
        await backfillStatistics(storage, rest, pause, () => false);
        assert.strictEqual(row(temp.id, at(9, 11)).avg, 20);
        assert.strictEqual(row(temp.id, at(9, 12)).avg, 22, 'the change at the start of the second run');
        assert.strictEqual(row(temp.id, at(10, 0)).avg, 21);
        assert.strictEqual(storage.statHourBounds().lastBackfill, at(11, 23));
    });

    it('stops at the first live hour and not further back than the profile', async () => {
        storage.writeStatHours([
            {
                ts: at(11, 12),
                dp: temp.id,
                how: 0,
                min: 21,
                max: 21,
                avg: 21,
                last: 21,
                onSec: 3600,
                changes: 0,
                updates: 6,
                maxGap: 10 * MIN,
            },
        ]);
        assert.deepStrictEqual(backfillRange(storage, at(12, 0), at(12, 0, 10), 56), {
            from: at(9, 10),
            to: at(11, 12),
        });
        assert.deepStrictEqual(backfillRange(storage, at(12, 0), at(12, 0, 10), 2), {
            from: at(10, 0),
            to: at(11, 12),
        });
    });

    it('takes updates and changes of the baseline from the live statistics only', async () => {
        await backfillStatistics(storage, { from: at(9, 10), to: at(12, 0) }, pause, () => false);
        storage.writeStatHours([
            {
                ts: at(12, 0),
                dp: temp.id,
                how: 72,
                min: 21,
                max: 21,
                avg: 21,
                last: 21,
                onSec: 3600,
                changes: 0,
                updates: 6,
                maxGap: 10 * MIN,
            },
        ]);
        const builder = new ProfileBuilder();
        storage.readStatHourRange(0, at(13, 0)).forEach(r => builder.add(r));
        const baseline = builder.baselines().get(temp.id);
        assert.deepStrictEqual(
            [baseline.since, baseline.liveSince, baseline.hours, baseline.updates, baseline.maxGap],
            [at(9, 10), at(12, 0), 1, 6, 10 * MIN],
        );
        const gone = builder.baselines().get(removed.id);
        assert.deepStrictEqual([gone.liveSince, gone.hours, gone.updates], [null, 0, 0]);
        storage.saveBaselines(new Map([[temp.id, { ...baseline, onP95: 0, onCount: 0 }]]), at(12, 1));
        assert.strictEqual(storage.loadBaselines().baselines.get(temp.id).liveSince, at(12, 0));

        // profiles from the computed hours: learned for the value; the counted updates after 7 days
        assert.ok(!ratesLearned(baseline, at(18, 23), 14));
        assert.ok(ratesLearned(baseline, at(19, 0), 14));
        assert.ok(!ratesLearned({ ...baseline, liveSince: null }, at(30, 0), 14));
        for (let how = 0; how < 168; how++) {
            storage.writeProfileHour(how, builder.hour(how));
        }
        const cells = storage.readProfile(null, temp.id).get(temp.id);
        assert.ok(cells.size > 50);
        assert.strictEqual(cells.get(72).n, 1, 'Thursday 0:00: live');
        assert.strictEqual(cells.get(24).mean, 21, 'Tuesday 0:00: computed');
        assert.strictEqual(DAY, 24 * HOUR);
    });

    it('learns the profiles from the recording at the start of the detector', async () => {
        const logs = [];
        const host = {
            log: { debug() {}, info: text => logs.push(text), warn() {}, error: e => assert.fail(e) },
            storage: () => storage,
            datapoints: () => [window, temp, power],
            value: () => null,
            away: () => null,
            outdoorTemperature: async () => null,
            notify: async () => {},
            report: async () => {},
            now: () => at(12, 0, 10),
            pause,
        };
        const settings = { ...DEFAULT_ANOMALY_SETTINGS, learnDays: 2 };
        const detector = new AnomalyDetector(host, new HourStats(at(12, 0)), settings, true, 'de');
        await detector.start();
        assert.strictEqual(detector.profileOf(temp).learned, false);
        await detector.prepare(at(12, 0));
        assert.match(logs[1], /^Anomaly detection: statistics of 57 hours \(\d+ rows\) computed in/);
        const profile = detector.profileOf(temp);
        assert.strictEqual(profile.learned, true);
        assert.strictEqual(profile.ratesLearned, false);
        assert.strictEqual(profile.baseline.since, at(9, 10));
        const info = detector.renderInfo();
        assert.match(info, /alle 3 Datenpunkte sind gelernt/);
        assert.match(info, /vor dem 2026-11-12 00:00 wurde aus der vorhandenen Aufzeichnung nachberechnet/);
        assert.match(info, /sie starten am 2026-11-13/);
        // only once
        await detector.prepare(at(12, 0));
        assert.strictEqual(logs.length, 2);
    });
});
