'use strict';

const assert = require('node:assert');

const { SourceKind } = require('../../build/lib/types');
const {
    actionsPerWindow,
    addWindows,
    collectActions,
    isSimulatable,
    pickSourceDay,
    planDay,
    sunsetOf,
    sunsetShift,
    triggerMeansAway,
    windowStart,
} = require('../../build/lib/simulation');

const MIN = 60_000;
const HOUR = 60 * MIN;
// all times local, so that the tests do not depend on the time zone of the machine
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();

describe('presence simulation: rules', () => {
    describe('isSimulatable', () => {
        const writable = { write: true };
        const dp = extra => ({ category: 'light', role: 'switch.light', type: 'boolean', devType: 'light', ...extra });

        it('switches lights, dimmers and blinds', () => {
            assert.ok(isSimulatable(dp(), writable, false));
            assert.ok(isSimulatable(dp({ role: 'level.dimmer', type: 'number', devType: 'dimmer' }), writable, false));
            assert.ok(
                isSimulatable(
                    dp({ category: 'shading', role: 'level.blind', type: 'number', devType: 'blind' }),
                    writable,
                    false,
                ),
            );
        });

        it('never switches read-only states, heating, locks, sockets or gates', () => {
            assert.ok(!isSimulatable(dp(), { write: false }, false));
            assert.ok(!isSimulatable(dp(), undefined, false));
            assert.ok(
                !isSimulatable(dp({ category: 'climate', role: 'level.temperature', type: 'number' }), writable, true),
            );
            assert.ok(!isSimulatable(dp({ category: 'security', role: 'switch.lock' }), writable, true));
            assert.ok(!isSimulatable(dp({ category: 'sockets', role: 'switch', devType: 'socket' }), writable, true));
            // a light category does not help a lock, a gate or a socket
            assert.ok(!isSimulatable(dp({ role: 'switch.lock.door' }), writable, true));
            assert.ok(!isSimulatable(dp({ role: 'switch.gate' }), writable, true));
            assert.ok(!isSimulatable(dp({ devType: 'socket' }), writable, true));
            // colour temperature of a light
            assert.ok(!isSimulatable(dp({ role: 'level.color.temperature', type: 'number' }), writable, true));
            // the actual position of a blind
            assert.ok(!isSimulatable(dp({ category: 'shading', role: 'value.blind', type: 'number' }), writable, true));
        });

        it('switches media only if enabled', () => {
            const tv = dp({ category: 'media', role: 'switch.power', devType: 'media' });
            assert.ok(!isSimulatable(tv, writable, false));
            assert.ok(isSimulatable(tv, writable, true));
            assert.ok(!isSimulatable({ ...tv, role: 'media.volume', type: 'number' }, writable, true));
        });
    });

    it('reads the trigger state', () => {
        assert.strictEqual(triggerMeansAway(true, false), true);
        assert.strictEqual(triggerMeansAway(false, false), false);
        assert.strictEqual(triggerMeansAway(1, false), true);
        assert.strictEqual(triggerMeansAway(0, false), false);
        assert.strictEqual(triggerMeansAway('on', false), true);
        assert.strictEqual(triggerMeansAway('Off', false), false);
        assert.strictEqual(triggerMeansAway('', false), false);
        assert.strictEqual(triggerMeansAway(null, false), false);
        // a presence state: true is at home
        assert.strictEqual(triggerMeansAway(true, true), false);
        assert.strictEqual(triggerMeansAway(false, true), true);
    });

    describe('collectActions', () => {
        const USER = 1;
        const SCRIPT = 2;
        const DEVICE = 3;
        const SELF = 4;
        const kinds = {
            [USER]: SourceKind.User,
            [SCRIPT]: SourceKind.Script,
            [DEVICE]: SourceKind.Adapter,
            [SELF]: SourceKind.Adapter,
        };
        const kindOf = src => kinds[src];
        const ev = (ts, dp, val, src, ack) => ({ ts, dp, val, sval: null, ack, src });
        const T = at(10, 18);

        it('takes commands of persons and switches pressed on the wall', () => {
            const actions = collectActions(
                [
                    ev(T, 1, 1, USER, false),
                    ev(T + 1000, 1, 1, DEVICE, true), // the answer of the lamp
                    ev(T + 10 * MIN, 2, 1, DEVICE, true), // pressed on the wall
                    ev(T + 20 * MIN, 2, 1, DEVICE, true), // no change
                    ev(T + 30 * MIN, 3, 1, SCRIPT, false), // a script
                    ev(T + 30 * MIN + 500, 3, 1, DEVICE, true),
                    ev(T + 40 * MIN, 1, 0, SELF, false), // another adapter (the simulation)
                    ev(T + 40 * MIN + 500, 1, 0, DEVICE, true),
                ],
                kindOf,
                new Map([
                    [1, 0],
                    [2, 0],
                    [3, 0],
                ]),
                false,
            );
            assert.deepStrictEqual(actions, [
                { ts: T, dp: 1, val: 1, kind: 'user' },
                { ts: T + 10 * MIN, dp: 2, val: 1, kind: 'device' },
            ]);
        });

        it('takes commands of scripts only if asked', () => {
            const events = [ev(T, 3, 1, SCRIPT, false), ev(T + 500, 3, 1, DEVICE, true)];
            assert.deepStrictEqual(collectActions(events, kindOf, new Map([[3, 0]]), true), [
                { ts: T, dp: 3, val: 1, kind: 'script' },
            ]);
        });

        it('does not count a change without a known previous value', () => {
            assert.deepStrictEqual(collectActions([ev(T, 2, 1, DEVICE, true)], kindOf, new Map(), false), []);
        });

        it('counts a device change long after a command', () => {
            const actions = collectActions(
                [ev(T, 1, 1, USER, false), ev(T + 5 * MIN, 1, 0, DEVICE, true)],
                kindOf,
                new Map([[1, 0]]),
                false,
            );
            assert.deepStrictEqual(
                actions.map(a => a.kind),
                ['user', 'device'],
            );
        });

        it('merges a dimmer slider into one action with the last value', () => {
            const actions = collectActions(
                [
                    ev(T, 5, 10, USER, false),
                    ev(T + 5000, 5, 40, USER, false),
                    ev(T + 20000, 5, 70, USER, false),
                    ev(T + 5 * MIN, 5, 0, USER, false),
                ],
                kindOf,
                new Map([[5, 0]]),
                false,
            );
            assert.deepStrictEqual(actions, [
                { ts: T + 20000, dp: 5, val: 70, kind: 'user' },
                { ts: T + 5 * MIN, dp: 5, val: 0, kind: 'user' },
            ]);
        });
    });

    describe('days', () => {
        it('runs a simulated day from noon to noon', () => {
            assert.strictEqual(windowStart(at(17, 9)), at(16, 12));
            assert.strictEqual(windowStart(at(17, 12)), at(17, 12));
            assert.strictEqual(windowStart(at(17, 23, 59)), at(17, 12));
            assert.strictEqual(addWindows(at(16, 12), 1), at(17, 12));
            assert.strictEqual(addWindows(at(16, 12), -7), at(9, 12));
            // over the change to summer time
            const march = new Date(2026, 2, 28, 12).getTime();
            assert.strictEqual(new Date(addWindows(march, 1)).getHours(), 12);
        });

        it('chooses the same weekday on which somebody was at home', () => {
            const target = at(18, 12);
            const counts = new Map([
                [at(11, 12), 2], // one week back: too few actions, away
                [at(4, 12), 12], // two weeks back
                [at(12, 12), 30], // another weekday
            ]);
            assert.deepStrictEqual(
                pickSourceDay(target, counts, 4, () => 0.99),
                {
                    start: at(4, 12),
                    sameWeekday: true,
                },
            );
            // not further back than asked
            assert.deepStrictEqual(
                pickSourceDay(target, counts, 1, () => 0.99),
                {
                    start: at(12, 12),
                    sameWeekday: false,
                },
            );
            counts.set(at(11, 12), 3);
            assert.strictEqual(pickSourceDay(target, counts, 4, () => 0).start, at(11, 12));
            assert.strictEqual(pickSourceDay(target, counts, 4, () => 0.6).start, at(4, 12));
            assert.strictEqual(
                pickSourceDay(target, new Map([[at(18, 12), 10]]), 4, () => 0),
                null,
                'not the day itself',
            );
        });

        it('counts the actions per simulated day', () => {
            const counts = actionsPerWindow([
                { ts: at(10, 19), dp: 1, val: 1, kind: 'user' },
                { ts: at(11, 1), dp: 1, val: 0, kind: 'user' },
                { ts: at(11, 13), dp: 1, val: 1, kind: 'user' },
            ]);
            assert.deepStrictEqual(
                [...counts],
                [
                    [at(10, 12), 2],
                    [at(11, 12), 1],
                ],
            );
        });
    });

    describe('planDay', () => {
        const source = at(11, 12);
        const target = at(18, 12);
        const action = (ts, dp, val) => ({ ts, dp, val, kind: 'user' });

        it('keeps the time of day', () => {
            const plan = planDay(
                [
                    action(at(11, 19), 1, 1),
                    action(at(12, 0, 30), 1, 0),
                    action(at(12, 13), 1, 1),
                    action(at(11, 11), 1, 1),
                ],
                source,
                target,
                { jitter: 0, sunsetShift: 0 },
                Math.random,
            );
            assert.deepStrictEqual(
                plan.map(a => [a.ts, a.sourceTs]),
                [
                    [at(18, 19), at(11, 19)],
                    [at(19, 0, 30), at(12, 0, 30)],
                ],
                'only the actions of the recorded day',
            );
        });

        it('shifts the evening by the sunset, not the night', () => {
            const plan = planDay(
                [action(at(11, 19), 1, 1), action(at(12, 1), 1, 0)],
                source,
                target,
                { jitter: 0, sunsetShift: -10 * MIN },
                Math.random,
            );
            assert.deepStrictEqual(
                plan.map(a => a.ts),
                [at(18, 18, 50), at(19, 1)],
            );
        });

        it('shifts a group of actions by one random offset and keeps the order of a datapoint', () => {
            const plan = planDay(
                [
                    action(at(11, 20), 1, 1),
                    action(at(11, 20) + 30_000, 2, 1),
                    action(at(11, 20) + 60_000, 1, 0),
                    action(at(11, 22), 3, 1),
                ],
                source,
                target,
                { jitter: 10, sunsetShift: 0 },
                (() => {
                    const values = [1, 0];
                    return () => values.shift();
                })(),
            );
            // first group +10 min, second group -10 min
            assert.deepStrictEqual(
                plan.map(a => a.ts),
                [at(18, 20, 10), at(18, 20, 10) + 30_000, at(18, 20, 10) + 60_000, at(18, 21, 50)],
            );
            const late = planDay(
                [action(at(11, 20), 1, 1), action(at(11, 20) + 10_000, 1, 0)],
                source,
                target,
                { jitter: 0, sunsetShift: 0 },
                Math.random,
            );
            assert.strictEqual(late[1].ts - late[0].ts, MIN, 'one minute apart at least');
        });

        it('stays within the simulated day', () => {
            const plan = planDay(
                [action(at(11, 12, 1), 1, 1), action(at(12, 11, 59), 1, 0)],
                source,
                target,
                { jitter: 20, sunsetShift: 0 },
                (() => {
                    const values = [0, 1];
                    return () => values.shift();
                })(),
            );
            assert.strictEqual(plan[0].ts, target);
            assert.strictEqual(plan[1].ts, at(19, 12) - 1);
        });
    });

    describe('sunset', () => {
        const BERLIN = [52.52, 13.405];
        const near = (actual, expected, text) =>
            assert.ok(Math.abs(actual - expected) <= 3 * MIN, `${text}: ${new Date(actual).toISOString()}`);

        it('computes the sunset to a few minutes', () => {
            // 21:33 CEST and 15:54 CET
            near(sunsetOf(Date.UTC(2026, 5, 21, 12), ...BERLIN), Date.UTC(2026, 5, 21, 19, 33), 'June');
            near(sunsetOf(Date.UTC(2026, 11, 21, 12), ...BERLIN), Date.UTC(2026, 11, 21, 14, 54), 'December');
            assert.strictEqual(sunsetOf(Date.UTC(2026, 5, 21, 12), 80, 15), null, 'polar day');
        });

        it('gives the shift between two days', () => {
            const settings = {
                weeks: 4,
                jitter: 0,
                sunset: true,
                media: false,
                scripts: false,
                latitude: 52.52,
                longitude: 13.405,
            };
            const source = at(4, 12);
            const target = at(18, 12);
            const shift = sunsetShift(source, target, settings);
            // in November the sun sets about a minute earlier every day
            assert.ok(shift < -10 * MIN && shift > -30 * MIN, `${shift / MIN} min`);
            assert.strictEqual(sunsetShift(source, target, { ...settings, sunset: false }), 0);
            assert.strictEqual(sunsetShift(source, target, { ...settings, latitude: undefined }), 0);
        });
    });
});
