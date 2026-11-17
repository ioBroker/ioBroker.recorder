'use strict';

const assert = require('node:assert');
const {
    ChangeFilter,
    RateMeter,
    filterRuleFor,
    isSignificant,
    nextRate,
    parseRoleRules,
    OTHER_NUMBERS,
} = require('../../build/lib/filter');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 18, 12, 0);

const ev = (ts, val, dp = 1) => ({ ts, dp, val, sval: null, ack: true, src: 1 });
const RULE = { deadband: 0.5, relative: false, minInterval: MIN, heartbeat: HOUR };
const CONTINUOUS = { rule: RULE, burst: true };
const DISCRETE = { rule: null, burst: true };

describe('filter rules', () => {
    it('takes the defaults of the plan per role', () => {
        assert.deepStrictEqual(filterRuleFor({ role: 'value.temperature' }), {
            deadband: 0.2,
            relative: false,
            minInterval: MIN,
            heartbeat: HOUR,
        });
        assert.strictEqual(filterRuleFor({ role: 'value.temperature.feelslike' }).deadband, 0.2);
        assert.deepStrictEqual(filterRuleFor({ role: 'value.power' }), {
            deadband: 5,
            relative: true,
            minInterval: MIN,
            heartbeat: 15 * MIN,
        });
        assert.strictEqual(filterRuleFor({ role: 'level.dimmer', min: 0, max: 100 }).deadband, 1);
        assert.strictEqual(filterRuleFor({ role: 'level.dimmer', min: 0, max: 1 }).deadband, 0.01, 'range 0..1');
        assert.strictEqual(filterRuleFor({ role: 'level.dimmer' }).minInterval, 0, 'user actions are not delayed');
        assert.deepStrictEqual(filterRuleFor({ role: 'value' }), OTHER_NUMBERS);
        assert.deepStrictEqual(filterRuleFor({}), OTHER_NUMBERS);
    });

    it('lets the role rules of the settings override the defaults', () => {
        const rules = parseRoleRules([
            { role: 'value.temperature*', deadband: '0.5', relative: false, minInterval: 300, heartbeat: 120 },
            { role: '', deadband: 9 },
            null,
        ]);
        assert.strictEqual(rules.length, 1);
        assert.deepStrictEqual(filterRuleFor({ role: 'value.temperature.dewpoint' }, rules), {
            deadband: 0.5,
            relative: false,
            minInterval: 300 * SEC,
            heartbeat: 120 * MIN,
        });
        assert.strictEqual(filterRuleFor({ role: 'value.humidity' }, rules).deadband, 2);
        assert.deepStrictEqual(parseRoleRules('nonsense'), []);
        // a deep merge of the settings turns the array into an object
        assert.strictEqual(parseRoleRules({ 0: { role: 'value', minInterval: 0 } }).length, 1);
    });

    it('compares with the dead band', () => {
        const abs = { deadband: 0.2, relative: false, minInterval: 0, heartbeat: 0 };
        assert.strictEqual(isSignificant(abs, 20, 20.2), true, '20.0 -> 20.2 despite floating point');
        assert.strictEqual(isSignificant(abs, 20, 20.1), false);
        assert.strictEqual(isSignificant(abs, 20, 19.7), true);
        const rel = { deadband: 10, relative: true, minInterval: 0, heartbeat: 0 };
        assert.strictEqual(isSignificant(rel, 100, 109), false);
        assert.strictEqual(isSignificant(rel, 100, 110), true);
        assert.strictEqual(isSignificant(rel, 0, 0.1), true);
        assert.strictEqual(isSignificant(abs, null, 1), true);
        assert.strictEqual(isSignificant(abs, 1, null), true);
        assert.strictEqual(isSignificant({ ...abs, deadband: 0 }, 1, 1.0001), true);
    });
});

describe('change filter', () => {
    it('stores every change of discrete datapoints', () => {
        const filter = new ChangeFilter(60);
        assert.ok(filter.offer(ev(T0, 1), DISCRETE));
        assert.ok(filter.offer(ev(T0 + 1, 0), DISCRETE));
        assert.ok(filter.offer(ev(T0 + 2, 1), DISCRETE));
    });

    it('applies dead band, minimum interval and heartbeat', () => {
        const filter = new ChangeFilter(60);
        filter.setBase(1, 20, T0);
        assert.strictEqual(filter.offer(ev(T0 + 10 * SEC, 20.2), CONTINUOUS), null, 'within the dead band');
        assert.strictEqual(filter.offer(ev(T0 + 20 * SEC, 21), CONTINUOUS), null, 'too early');
        assert.deepStrictEqual(filter.due(T0 + 30 * SEC, () => CONTINUOUS), []);
        assert.deepStrictEqual(
            filter.due(T0 + 61 * SEC, () => CONTINUOUS).map(e => [e.ts - T0, e.val]),
            [[20 * SEC, 21]],
            'stored when the minimum interval is over, with its own time',
        );

        assert.strictEqual(filter.offer(ev(T0 + 2 * MIN, 21.1), CONTINUOUS), null);
        assert.deepStrictEqual(filter.due(T0 + 30 * MIN, () => CONTINUOUS), []);
        assert.deepStrictEqual(
            filter.due(T0 + 20 * SEC + HOUR, () => CONTINUOUS).map(e => e.val),
            [21.1],
            'the heartbeat stores the change within the dead band',
        );

        const stored = filter.offer(ev(T0 + 2 * HOUR, 25), CONTINUOUS);
        assert.strictEqual(stored?.val, 25, 'a big change after the interval is stored at once');
    });

    it('keeps the latest value within the minimum interval', () => {
        const filter = new ChangeFilter(60);
        filter.setBase(1, 20, T0);
        assert.strictEqual(filter.offer(ev(T0 + 10 * SEC, 22), CONTINUOUS), null);
        assert.strictEqual(filter.offer(ev(T0 + 20 * SEC, 23), CONTINUOUS), null);
        assert.deepStrictEqual(
            filter.due(T0 + 70 * SEC, () => CONTINUOUS).map(e => e.val),
            [23],
        );
        assert.deepStrictEqual(filter.due(T0 + 2 * HOUR, () => CONTINUOUS), [], 'nothing held anymore');
    });

    it('does not store ack changes of continuous datapoints', () => {
        const filter = new ChangeFilter(60);
        filter.setBase(1, 20, T0);
        assert.strictEqual(filter.offer({ ...ev(T0 + 2 * MIN, 20), ack: false }, CONTINUOUS), null);
        assert.deepStrictEqual(filter.due(T0 + 2 * HOUR, () => CONTINUOUS), []);
        assert.deepStrictEqual(filter.takeHeld(), []);
    });

    it('throttles a datapoint above the burst limit', () => {
        const filter = new ChangeFilter(3);
        const throttled = [];
        filter.onThrottle = dp => throttled.push(dp);
        const stored = [];
        for (let i = 0; i < 6; i++) {
            const e = filter.offer(ev(T0 + i * SEC, i % 2), DISCRETE);
            if (e) {
                stored.push(e.val);
            }
        }
        assert.deepStrictEqual(stored, [0, 1, 0]);
        assert.deepStrictEqual(throttled, [1], 'reported once');
        assert.deepStrictEqual(filter.due(T0 + 30 * SEC, () => DISCRETE), [], 'still the same minute');
        assert.deepStrictEqual(
            filter.due(T0 + MIN, () => DISCRETE).map(e => e.val),
            [1],
            'the latest value in the next minute',
        );

        const unlimited = new ChangeFilter(3);
        let count = 0;
        for (let i = 0; i < 10; i++) {
            if (unlimited.offer(ev(T0 + i, i % 2), { rule: null, burst: false })) {
                count++;
            }
        }
        assert.strictEqual(count, 10, '"every change" is not throttled');
    });

    it('returns the held values on unload and forgets removed datapoints', () => {
        const filter = new ChangeFilter(60);
        filter.setBase(1, 20, T0);
        filter.setBase(2, 5, T0);
        filter.offer(ev(T0 + SEC, 22, 1), CONTINUOUS);
        filter.offer(ev(T0 + SEC, 9, 2), CONTINUOUS);
        filter.remove(2);
        assert.deepStrictEqual(
            filter.takeHeld().map(e => [e.dp, e.val]),
            [[1, 22]],
        );
        filter.offer(ev(T0 + 2 * SEC, 30, 1), CONTINUOUS);
        assert.deepStrictEqual(filter.due(T0 + HOUR, () => undefined), [], 'not recorded anymore');
    });
});

describe('rates', () => {
    it('measures the changes per minute', () => {
        const meter = new RateMeter(T0);
        for (let i = 0; i < 120; i++) {
            meter.count(1);
        }
        meter.count(2);
        assert.strictEqual(meter.close(T0 + 10 * MIN, [1, 2, 3]), null, 'too short');
        const rates = meter.close(T0 + HOUR, [1, 2, 3]);
        assert.deepStrictEqual([...rates], [
            [1, 2],
            [2, 0.02],
            [3, 0],
        ]);
        assert.deepStrictEqual([...meter.close(T0 + 2 * HOUR, [1])], [[1, 0]], 'a new measurement');
    });

    it('classifies with hysteresis', () => {
        let rate = nextRate(undefined, 7, 6, T0);
        assert.strictEqual(rate.high, true);
        rate = nextRate(rate, 4, 6, T0 + HOUR);
        assert.strictEqual(rate.high, true, 'stays high above half of the limit');
        assert.strictEqual(rate.maxPerMin, 7);
        rate = nextRate(rate, 2, 6, T0 + 2 * HOUR);
        assert.strictEqual(rate.high, false);
        assert.strictEqual(nextRate(undefined, 6, 6, T0).high, false, 'the limit itself is not high');
    });
});
