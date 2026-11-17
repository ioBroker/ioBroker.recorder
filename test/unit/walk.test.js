'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');
const { readSnapshot, readEventList, readTimeline, readChanges, stateText } = require('../../build/lib/walk');

const MIN = 60_000;
const HOUR = 60 * MIN;
// Monday 2026-11-16 00:00 UTC is the start of week 47
const MONDAY = Date.UTC(2026, 10, 16);
const T0 = MONDAY + 10 * HOUR;
const NO_PENDING = { events: [], aggregates: [] };

function definition(oid, extra) {
    return {
        oid,
        name: oid.split('.').pop(),
        room: null,
        func: null,
        role: 'state',
        unit: null,
        devType: null,
        category: null,
        cls: DpClass.Discrete,
        type: 'number',
        states: null,
        ...extra,
    };
}

describe('walk into the past', () => {
    let dir;
    let storage;
    let light;
    let window;
    let temp;
    let power;
    let user;
    let device;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-walk-'));
        storage = new Storage(dir);
        storage.open();
        light = storage.upsertDp(
            definition('hue.0.bath.on', {
                name: 'Light',
                room: 'Bad',
                category: 'light',
                role: 'switch.light',
                type: 'boolean',
            }),
        );
        window = storage.upsertDp(
            definition('hm.0.window.state', {
                name: 'Window',
                room: 'Bad, Flur',
                category: 'windowsDoors',
                role: 'value.window',
                states: JSON.stringify({ 0: 'closed', 1: 'tilted', 2: 'open' }),
            }),
        );
        temp = storage.upsertDp(
            definition('hm.0.kitchen.temp', {
                name: 'Temperature',
                room: 'Küche',
                category: 'climate',
                role: 'value.temperature',
                unit: '°C',
                cls: DpClass.Continuous,
            }),
        );
        power = storage.upsertDp(
            definition('shelly.0.power', { name: 'Power', category: 'energy', cls: DpClass.Aggregated, unit: 'W' }),
        );
        user = storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User);
        device = storage.getSourceId('system.adapter.hue.0', undefined, SourceKind.Adapter);

        const ev = (ts, dp, val, src = device, ack = true) => ({ ts, dp: dp.id, val, sval: null, ack, src });
        storage.write(
            [
                ev(T0 + 5 * MIN, light, 1, user, false),
                ev(T0 + 6 * MIN, window, 2),
                ev(T0 + 20 * MIN, temp, 21.5),
                ev(T0 + 40 * MIN, light, 0, user, false),
            ],
            {
                ts: T0,
                rows: [
                    { dp: light.id, val: 0, sval: null },
                    { dp: window.id, val: 0, sval: null },
                    { dp: temp.id, val: 20, sval: null },
                    { dp: power.id, val: 100, sval: null },
                ],
            },
            [
                { ts: T0, dp: power.id, min: 90, max: 300, avg: 150, last: 250 },
                { ts: T0 + 5 * MIN, dp: power.id, min: 200, max: 400, avg: 300, last: 380 },
            ],
        );
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const valuesOf = snapshot => Object.fromEntries(snapshot.states.map(s => [s.id, s.val]));

    it('has nothing before the first keyframe', () => {
        const snapshot = readSnapshot(storage, { ts: T0 - 1 }, NO_PENDING, T0 + HOUR);
        assert.strictEqual(snapshot.keyframe, null);
        assert.deepStrictEqual(snapshot.states, []);
    });

    it('reconstructs the state from the keyframe and the changes', () => {
        const snapshot = readSnapshot(storage, { ts: T0 + 8 * MIN }, NO_PENDING, T0 + HOUR);
        assert.strictEqual(snapshot.keyframe, T0);
        assert.deepStrictEqual(valuesOf(snapshot), {
            'hm.0.kitchen.temp': 20,
            'hm.0.window.state': 2,
            'hue.0.bath.on': true,
            // the interval T0 .. T0 + 5 min is over, the next one ends at T0 + 10 min
            'shelly.0.power': 250,
        });
        const lamp = snapshot.states.find(s => s.id === 'hue.0.bath.on');
        assert.strictEqual(lamp.lc, T0 + 5 * MIN);
        assert.strictEqual(lamp.src, 'user');
        assert.strictEqual(lamp.user, 'system.user.admin');
        assert.strictEqual(lamp.ack, false);
        assert.strictEqual(lamp.room, 'Bad');
        const win = snapshot.states.find(s => s.id === 'hm.0.window.state');
        assert.strictEqual(win.text, 'open');
        assert.strictEqual(win.src, 'adapter');
        assert.strictEqual(snapshot.states.find(s => s.id === 'hm.0.kitchen.temp').lc, null, 'from the keyframe');
        assert.strictEqual(snapshot.states.find(s => s.id === 'shelly.0.power').aggregated, true);

        assert.deepStrictEqual(valuesOf(readSnapshot(storage, { ts: T0 + 50 * MIN }, NO_PENDING, T0 + HOUR)), {
            'hm.0.kitchen.temp': 21.5,
            'hm.0.window.state': 2,
            'hue.0.bath.on': false,
            'shelly.0.power': 380,
        });
        // an ISO string works as well
        const iso = readSnapshot(storage, { ts: new Date(T0 + 10 * MIN).toISOString() }, NO_PENDING, T0 + HOUR);
        assert.strictEqual(iso.ts, T0 + 10 * MIN);
    });

    it('filters by room and category', () => {
        const bath = readSnapshot(storage, { ts: T0 + 10 * MIN, room: 'bad' }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(
            bath.states.map(s => s.id),
            ['hm.0.window.state', 'hue.0.bath.on'],
            'a datapoint in two rooms belongs to both',
        );
        const hall = readSnapshot(storage, { ts: T0 + 10 * MIN, room: ['Flur'] }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(
            hall.states.map(s => s.id),
            ['hm.0.window.state'],
        );
        const climate = readSnapshot(storage, { ts: T0 + 30 * MIN, category: 'climate' }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(valuesOf(climate), { 'hm.0.kitchen.temp': 21.5 });
        const none = readSnapshot(storage, { ts: T0 + 30 * MIN, room: 'Garage' }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(none.states, []);
    });

    it('includes the data that is not written yet', () => {
        const pending = {
            events: [{ ts: T0 + 55 * MIN, dp: temp.id, val: 23, sval: null, ack: true, src: device }],
            aggregates: [{ ts: T0 + 10 * MIN, dp: power.id, min: 1, max: 2, avg: 1.5, last: 2 }],
        };
        assert.deepStrictEqual(valuesOf(readSnapshot(storage, { ts: T0 + 56 * MIN }, pending, T0 + HOUR)), {
            'hm.0.kitchen.temp': 23,
            'hm.0.window.state': 2,
            'hue.0.bath.on': false,
            'shelly.0.power': 2,
        });
    });

    it('finds the keyframe of the previous week', () => {
        // a new week without a keyframe yet: the last keyframe is in the previous file
        const nextMonday = MONDAY + 7 * 24 * HOUR;
        storage.write([{ ts: nextMonday + MIN, dp: temp.id, val: 18, sval: null, ack: true, src: device }]);
        assert.deepStrictEqual(storage.listWeekFiles().length, 2);
        const snapshot = readSnapshot(storage, { ts: nextMonday + 2 * MIN }, NO_PENDING, nextMonday + HOUR);
        assert.strictEqual(snapshot.keyframe, T0);
        assert.deepStrictEqual(valuesOf(snapshot)['hm.0.kitchen.temp'], 18);
        assert.deepStrictEqual(valuesOf(snapshot)['hue.0.bath.on'], false);
    });

    it('returns the changes between two times for the replay', () => {
        const changes = readChanges(storage, T0 + 5 * MIN, T0 + 40 * MIN, NO_PENDING);
        assert.deepStrictEqual(
            changes.map(c => [c.id, c.val]).sort(),
            [
                ['hm.0.kitchen.temp', 21.5],
                ['hm.0.window.state', 2],
                ['hue.0.bath.on', false],
                // the second interval ended at T0 + 10 min
                ['shelly.0.power', 380],
            ],
            'the change at the start is not included, the one at the end is',
        );
    });

    it('lists the events with names, rooms and sources', () => {
        const answer = readEventList(storage, { start: T0, end: T0 + HOUR }, NO_PENDING, T0 + HOUR);
        assert.strictEqual(answer.more, false);
        assert.deepStrictEqual(
            answer.events.map(e => [e.ts - T0, e.name, e.val]),
            [
                [5 * MIN, 'Light', true],
                [6 * MIN, 'Window', 2],
                [20 * MIN, 'Temperature', 21.5],
                [40 * MIN, 'Light', false],
            ],
        );
        assert.strictEqual(answer.events[1].text, 'open');
        assert.strictEqual(answer.events[2].unit, '°C');

        const manual = readEventList(storage, { start: T0, end: T0 + HOUR, src: 'user' }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(
            manual.events.map(e => [e.name, e.src, e.from]),
            [
                ['Light', 'user', 'system.adapter.vis-2.0'],
                ['Light', 'user', 'system.adapter.vis-2.0'],
            ],
        );

        const limited = readEventList(storage, { start: T0, end: T0 + HOUR, limit: 2 }, NO_PENDING, T0 + HOUR);
        assert.strictEqual(limited.more, true);
        assert.deepStrictEqual(
            limited.events.map(e => e.ts - T0),
            [5 * MIN, 6 * MIN],
        );
        const newest = readEventList(
            storage,
            { start: T0, end: T0 + HOUR, limit: 2, newest: true },
            NO_PENDING,
            T0 + HOUR,
        );
        assert.deepStrictEqual(
            newest.events.map(e => e.ts - T0),
            [20 * MIN, 40 * MIN],
            'the newest, still sorted by time',
        );

        // the default period is the hour before the end
        const lastHour = readEventList(storage, { end: T0 + 30 * MIN, category: 'climate' }, NO_PENDING, T0 + HOUR);
        assert.deepStrictEqual(
            lastHour.events.map(e => e.id),
            ['hm.0.kitchen.temp'],
        );
    });

    it('counts the events per interval for the timeline', () => {
        const answer = readTimeline(storage, { start: T0, end: T0 + HOUR, buckets: 4 }, T0 + HOUR);
        assert.strictEqual(answer.step, 15 * MIN);
        assert.deepStrictEqual(answer.counts, [2, 1, 1, 0]);
        assert.strictEqual(answer.first, T0);
        const manual = readTimeline(storage, { start: T0, end: T0 + HOUR, buckets: 4, src: 'user' }, T0 + HOUR);
        assert.deepStrictEqual(manual.counts, [1, 0, 1, 0]);
        const bath = readTimeline(storage, { start: T0, end: T0 + HOUR, buckets: 2, room: 'Bad' }, T0 + HOUR);
        assert.deepStrictEqual(bath.counts, [2, 1]);
    });

    it('takes the text of a value from common.states', () => {
        assert.strictEqual(stateText(JSON.stringify({ 0: 'off', 1: 'on' }), 1), 'on');
        assert.strictEqual(stateText(JSON.stringify({ true: 'open', false: 'closed' }), true), 'open');
        assert.strictEqual(stateText(JSON.stringify('0:closed;1:tilted;2:open'), 1), 'tilted');
        assert.strictEqual(stateText(JSON.stringify(['a', 'b']), 'a'), undefined);
        assert.strictEqual(stateText(null, 1), undefined);
        assert.strictEqual(stateText(JSON.stringify({ 0: 'off' }), 5), undefined);
    });
});
