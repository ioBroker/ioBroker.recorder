'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');
const { HourStats, hourOfWeek } = require('../../build/lib/stats');
const { DEFAULT_ANOMALY_SETTINGS } = require('../../build/lib/anomaly');
const { AnomalyDetector } = require('../../build/lib/detector');

const MIN = 60_000;
const HOUR = 60 * MIN;
// local times; three weeks of statistics from Monday 2026-10-26 to Monday 2026-11-16
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const FIRST = new Date(2026, 9, 26, 0).getTime();
const NOW = at(16, 2, 30);

function definition(oid, extra) {
    return {
        oid,
        name: oid.split('.').pop(),
        room: 'Flur',
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

describe('anomaly detection: detector', () => {
    let dir;
    let storage;
    let door;
    let window;
    let temp;
    let dps;
    let stats;
    let host;
    let detector;
    let values;
    let notes;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-anomaly-'));
        storage = new Storage(dir);
        storage.open();
        door = storage.upsertDp(
            definition('zigbee.0.door.open', { name: 'Haustür', category: 'windowsDoors', role: 'sensor.door' }),
        );
        window = storage.upsertDp(
            definition('zigbee.0.window.open', {
                name: 'Fenster',
                room: 'Bad',
                category: 'windowsDoors',
                role: 'sensor.window',
            }),
        );
        temp = storage.upsertDp(
            definition('zigbee.0.bath.temperature', {
                name: 'Temperatur',
                room: 'Bad',
                category: 'climate',
                role: 'value.temperature',
                unit: '°C',
                type: 'number',
                cls: DpClass.Continuous,
            }),
        );
        dps = [door, window, temp];

        // three weeks: the door opens at 7 and 18 o'clock, the window at 10 o'clock for 10 minutes,
        // the temperature reports every 10 minutes around 21 °C
        const rows = [];
        const events = [];
        const device = storage.getSourceId('system.adapter.zigbee.0', undefined, SourceKind.Adapter);
        for (let day = 0; day < 21; day++) {
            for (let hour = 0; hour < 24; hour++) {
                const ts = new Date(2026, 9, 26 + day, hour).getTime();
                const how = hourOfWeek(ts);
                const doorActive = hour === 7 || hour === 18;
                rows.push({
                    ts,
                    dp: door.id,
                    how,
                    min: 0,
                    max: doorActive ? 1 : 0,
                    avg: doorActive ? 0.05 : 0,
                    last: 0,
                    onSec: doorActive ? 180 : 0,
                    changes: doorActive ? 2 : 0,
                    updates: doorActive ? 2 : 0,
                    maxGap: 0,
                });
                rows.push({
                    ts,
                    dp: window.id,
                    how,
                    min: 0,
                    max: hour === 10 ? 1 : 0,
                    avg: hour === 10 ? 0.17 : 0,
                    last: 0,
                    onSec: hour === 10 ? 600 : 0,
                    changes: hour === 10 ? 2 : 0,
                    updates: hour === 10 ? 2 : 0,
                    maxGap: 0,
                });
                const mean = 21 + Math.sin((hour / 24) * 2 * Math.PI) + (day % 3) * 0.2;
                rows.push({
                    ts,
                    dp: temp.id,
                    how,
                    min: mean - 0.3,
                    max: mean + 0.3,
                    avg: mean,
                    last: mean,
                    onSec: 3600,
                    changes: 6,
                    updates: 6,
                    maxGap: 10 * MIN,
                });
            }
            const open = new Date(2026, 9, 26 + day, 10).getTime();
            events.push({ ts: open, dp: window.id, val: 1, sval: null, ack: true, src: device });
            events.push({ ts: open + 10 * MIN, dp: window.id, val: 0, sval: null, ack: true, src: device });
        }
        storage.writeStatHours(rows);
        storage.write(events, {
            ts: FIRST,
            rows: dps.map(dp => ({ dp: dp.id, val: dp === temp ? 21 : 0, sval: null })),
        });

        values = { [door.id]: 0, [window.id]: 0, [temp.id]: 21 };
        notes = [];
        stats = new HourStats(Math.floor(NOW / HOUR) * HOUR);
        stats.init(door.id, 0, NOW - 8 * HOUR, NOW - 8 * HOUR);
        stats.init(window.id, 0, NOW - 16 * HOUR, NOW - 16 * HOUR);
        stats.init(temp.id, 21, NOW - 5 * MIN, NOW - 5 * MIN);
        host = {
            time: NOW,
            away: null,
            outdoor: { val: 12, name: 'Außentemperatur' },
            log: { debug() {}, info() {}, warn() {}, error: e => assert.fail(e) },
            storage: () => storage,
            datapoints: () => dps,
            value: dp => values[dp] ?? null,
            away() {
                return this.awayValue ?? null;
            },
            async outdoorTemperature() {
                return this.outdoor;
            },
            async notify(_anomaly, text) {
                notes.push(text);
            },
            async report(open) {
                this.open = open;
            },
            now() {
                return this.time;
            },
            pause: () => Promise.resolve(),
        };
        detector = new AnomalyDetector(host, stats, { ...DEFAULT_ANOMALY_SETTINGS }, true, 'de');
        await detector.start();
        // the profiles from the statistics (nothing to compute from the recording)
        await detector.prepare(stats.start);
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const rules = () => host.open.map(a => a.rule).sort();

    it('learns profiles and baselines from the statistics', () => {
        const { baselines } = storage.loadBaselines();
        assert.strictEqual(baselines.get(temp.id).hours, 21 * 24);
        assert.strictEqual(baselines.get(window.id).onCount, 21);
        assert.strictEqual(baselines.get(window.id).onP95, 10 * MIN);
        const profile = detector.profileOf(temp);
        assert.strictEqual(profile.learned, true);
        assert.strictEqual(profile.profile.length, 168);
        assert.strictEqual(profile.profile[0].n, 3);
        assert.match(detector.renderInfo(), /alle 3 Datenpunkte sind gelernt/);
    });

    it('reports the front door at 3 am, but not at 7 am', async () => {
        host.time = at(16, 3, 5);
        await detector.onChange(door, 1, false);
        assert.deepStrictEqual(rules(), ['rare']);
        assert.match(notes[0], /^Flur Haustür: geöffnet um 03:05, selten zu dieser Zeit$/);
        // not again within the quiet time, also after the acknowledgement
        assert.strictEqual(await detector.ack(null), 1);
        host.time = at(16, 3, 20);
        await detector.onChange(door, 1, false);
        assert.strictEqual(notes.length, 1);

        host.time = at(17, 7, 10);
        await detector.onChange(door, 1, false);
        assert.strictEqual(notes.length, 1, 'usual at 7 am');
    });

    it('reports every opening while nobody is at home', async () => {
        host.awayValue = true;
        host.time = at(17, 7, 10);
        await detector.onChange(door, 1, false);
        assert.match(notes[0], /obwohl niemand zu Hause ist/);
    });

    it('reports a silent sensor until it reports again', async () => {
        // last update at 2:25; at least 6 hours
        host.time = at(16, 8);
        await detector.check();
        assert.deepStrictEqual(rules(), []);
        host.time = at(16, 8, 30);
        await detector.check();
        assert.deepStrictEqual(rules(), ['silent']);
        assert.match(notes[0], /^Bad Temperatur: seit 6,1 Std\. keine Meldung \(sonst alle 10 Min\.\)$/);
        stats.update(temp.id, host.time, 21, false);
        await detector.check();
        assert.deepStrictEqual(rules(), []);
    });

    it('reports a window that is open in the cold', async () => {
        stats.update(window.id, NOW, 1, true);
        values[window.id] = 1;
        host.outdoor = { val: 2, name: 'Außentemperatur' };
        await detector.check();
        host.time = NOW + 20 * MIN;
        await detector.check();
        assert.deepStrictEqual(rules(), []);
        host.time = NOW + 31 * MIN;
        await detector.check();
        assert.deepStrictEqual(rules(), ['cold', 'long']);
        assert.ok(notes.includes('Bad Fenster: offen bei 2 °C draußen (Außentemperatur)'));
        assert.ok(notes.includes('Bad Fenster: seit 31 Min. offen (sonst höchstens 10 Min.)'));
        stats.update(window.id, host.time, 0, true);
        values[window.id] = 0;
        await detector.check();
        assert.deepStrictEqual(rules(), []);
    });

    it('reports an unusual value after 30 minutes', async () => {
        values[temp.id] = 35;
        await detector.check();
        host.time = NOW + 25 * MIN;
        stats.update(temp.id, host.time, 35, true);
        await detector.check();
        assert.deepStrictEqual(rules(), []);
        host.time = NOW + 31 * MIN;
        stats.update(temp.id, host.time, 35, false);
        await detector.check();
        assert.deepStrictEqual(rules(), ['value']);
        assert.match(notes[0], /^Bad Temperatur: 35 °C, sonst 2\d,\d+ °C bis 2\d,\d+ °C zu dieser Zeit$/);
    });

    it('reports a racing datapoint', async () => {
        host.time = at(16, 3);
        await detector.onHour([
            {
                ts: at(16, 2),
                dp: temp.id,
                how: hourOfWeek(at(16, 2)),
                min: 21,
                max: 22,
                avg: 21.5,
                last: 21,
                onSec: 3600,
                changes: 600,
                updates: 600,
                maxGap: 1000,
            },
        ]);
        assert.deepStrictEqual(rules(), ['racing']);
        assert.match(notes[0], /600 Änderungen in der letzten Stunde \(sonst 6\)/);
        await detector.onThrottle(door.id, 60);
        assert.match(notes[1], /^Flur Haustür: ändert sich öfter als 60-mal pro Minute/);
    });

    it('stays quiet while learning and when switched off', async () => {
        detector.enabled = false;
        host.time = at(16, 3, 5);
        await detector.onChange(door, 1, false);
        await detector.check();
        assert.deepStrictEqual(notes, []);
        assert.match(detector.renderInfo(), /ausgeschaltet/);
    });
});
