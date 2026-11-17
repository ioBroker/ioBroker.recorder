'use strict';

const assert = require('node:assert');
const { computeSelection, DeviceDetection } = require('../../build/lib/selection');
const { categoryModes, isNegativeRole, categoryOfRole } = require('../../build/lib/categories');
const { DpClass } = require('../../build/lib/types');

/** A small installation: hm-rpc (device/channel/state), zigbee (device/state), stand-alone states, alias, enums */
function createObjects() {
    const objects = {};
    const add = (id, type, common = {}) => (objects[id] = { _id: id, type, common: { name: id, ...common }, native: {} });
    const st = (id, role, type, extra = {}) => add(id, 'state', { role, type, read: true, write: false, ...extra });

    add('hm-rpc.0.ABC', 'device');
    add('hm-rpc.0.ABC.0', 'channel', { role: 'maintenance' });
    st('hm-rpc.0.ABC.0.UNREACH', 'indicator.unreach', 'boolean');
    add('hm-rpc.0.ABC.1', 'channel', { role: 'blind' });
    st('hm-rpc.0.ABC.1.LEVEL', 'level.blind', 'number', { write: true, min: 0, max: 100, unit: '%' });
    st('hm-rpc.0.ABC.1.STOP', 'button.stop', 'boolean', { write: true, read: false });
    st('hm-rpc.0.ABC.1.WORKING', 'indicator.working', 'boolean');

    add('zigbee.0.lamp', 'device');
    st('zigbee.0.lamp.state', 'switch', 'boolean', { write: true });
    st('zigbee.0.lamp.brightness', 'level.dimmer', 'number', { write: true, min: 0, max: 100 });
    st('zigbee.0.lamp.load_power', 'value.power', 'number', { unit: 'W' });
    st('zigbee.0.lamp.link_quality', 'state', 'number');
    st('zigbee.0.lamp.available', 'indicator.reachable', 'boolean');

    add('zigbee.0.sensor', 'device');
    st('zigbee.0.sensor.temperature', 'value.temperature', 'number', { unit: '°C' });
    st('zigbee.0.sensor.battery', 'value.battery', 'number', { unit: '%' });

    add('zigbee.0.motion', 'device');
    st('zigbee.0.motion.occupancy', 'sensor.motion', 'boolean');

    st('0_userdata.0.kitchenLight', 'switch.light', 'boolean', { write: true });
    st('0_userdata.0.counter', 'state', 'number', { write: true });
    st('0_userdata.0.note', 'text', 'string', { write: true });

    add('alias.0.Living.Blind', 'channel', { role: 'blind' });
    st('alias.0.Living.Blind.SET', 'level.blind', 'number', {
        write: true,
        min: 0,
        max: 100,
        alias: { id: 'hm-rpc.0.ABC.1.LEVEL' },
    });

    st('recorder.0.info.eventsToday', 'value', 'number');
    st('system.adapter.admin.0.alive', 'indicator.state', 'boolean');

    add('enum.rooms.kitchen', 'enum', { name: { en: 'Kitchen', de: 'Küche' }, members: ['zigbee.0.lamp'] });
    add('enum.functions.light', 'enum', { name: 'Light', members: ['zigbee.0.lamp.brightness'] });
    return objects;
}

function config(overrides = {}) {
    return {
        categories: categoryModes(overrides.native || {}),
        requireEnum: false,
        includePatterns: [],
        excludePatterns: [],
        ownNamespace: 'recorder.0',
        lang: 'de',
        ...overrides,
    };
}

describe('selection', () => {
    it('selects devices by the type detector and drops technical states', () => {
        const { selected } = computeSelection(createObjects(), config());
        const ids = [...selected.keys()].sort();

        // blind: position yes, buttons and indicators no; the target is covered by the alias
        assert.ok(!selected.has('hm-rpc.0.ABC.1.STOP'));
        assert.ok(!selected.has('hm-rpc.0.ABC.1.WORKING'));
        assert.ok(!selected.has('hm-rpc.0.ABC.0.UNREACH'));
        assert.ok(selected.has('alias.0.Living.Blind.SET'), ids.join());
        assert.ok(!selected.has('hm-rpc.0.ABC.1.LEVEL'), 'alias target must be dropped');
        assert.strictEqual(selected.get('alias.0.Living.Blind.SET').category, 'shading');
        assert.ok(selected.get('alias.0.Living.Blind.SET').reason.includes('alias of hm-rpc.0.ABC.1.LEVEL'));

        // lamp
        assert.strictEqual(selected.get('zigbee.0.lamp.brightness').category, 'light');
        assert.strictEqual(selected.get('zigbee.0.lamp.load_power').category, 'energy');
        assert.strictEqual(selected.get('zigbee.0.lamp.load_power').cls, DpClass.Aggregated);
        assert.ok(selected.has('zigbee.0.lamp.state'));
        assert.ok(!selected.has('zigbee.0.lamp.link_quality'));
        assert.ok(!selected.has('zigbee.0.lamp.available'));

        // sensor
        assert.strictEqual(selected.get('zigbee.0.sensor.temperature').category, 'climate');
        assert.strictEqual(selected.get('zigbee.0.sensor.temperature').cls, DpClass.Continuous);
        assert.ok(!selected.has('zigbee.0.sensor.battery'));

        // stand-alone
        assert.strictEqual(selected.get('0_userdata.0.kitchenLight').category, 'light');
        assert.ok(!selected.has('0_userdata.0.counter'));
        assert.ok(!selected.has('0_userdata.0.note'));

        // never: own namespace, system
        assert.ok(!selected.has('recorder.0.info.eventsToday'));
        assert.ok(!selected.has('system.adapter.admin.0.alive'));
    });

    it('keeps motion off by default for privacy', () => {
        assert.ok(!computeSelection(createObjects(), config()).selected.has('zigbee.0.motion.occupancy'));
        const on = computeSelection(createObjects(), config({ categories: categoryModes({ catMotion: 'on' }) }));
        assert.strictEqual(on.selected.get('zigbee.0.motion.occupancy').category, 'motion');
    });

    it('switches categories off and records energy raw if wanted', () => {
        const result = computeSelection(
            createObjects(),
            config({ categories: categoryModes({ catLight: 'off', catEnergy: 'on' }) }),
        );
        assert.ok(!result.selected.has('zigbee.0.lamp.brightness'));
        assert.ok(!result.selected.has('0_userdata.0.kitchenLight'));
        assert.strictEqual(result.selected.get('zigbee.0.lamp.load_power').cls, DpClass.Continuous);
        assert.ok(result.dropped['category light off'] >= 2);
    });

    it('fills rooms and functions from the state, its channel or its device', () => {
        const { selected } = computeSelection(createObjects(), config());
        assert.strictEqual(selected.get('zigbee.0.lamp.brightness').room, 'Küche');
        assert.strictEqual(selected.get('zigbee.0.lamp.brightness').func, 'Light');
        assert.strictEqual(selected.get('zigbee.0.lamp.state').room, 'Küche');
        assert.strictEqual(selected.get('zigbee.0.lamp.state').func, null);
        assert.strictEqual(selected.get('zigbee.0.sensor.temperature').room, null);
    });

    it('requires a room or function if configured', () => {
        const { selected } = computeSelection(createObjects(), config({ requireEnum: true }));
        assert.ok(selected.has('zigbee.0.lamp.brightness'));
        assert.ok(!selected.has('zigbee.0.sensor.temperature'));
        assert.ok(!selected.has('0_userdata.0.kitchenLight'));
    });

    it('applies include and exclude rules after the automatic levels', () => {
        const { selected } = computeSelection(
            createObjects(),
            config({
                requireEnum: true,
                includePatterns: ['0_userdata.0.*'],
                excludePatterns: ['zigbee.0.lamp.load_power', '0_userdata.0.note'],
            }),
        );
        assert.ok(selected.has('0_userdata.0.counter'), 'include overrides requireEnum');
        assert.strictEqual(selected.get('0_userdata.0.counter').reason, 'Include rule');
        assert.strictEqual(selected.get('0_userdata.0.counter').category, null);
        assert.ok(!selected.has('0_userdata.0.note'), 'exclude wins over include');
        assert.ok(!selected.has('zigbee.0.lamp.load_power'));
    });

    it('lets the per-state setting override everything', () => {
        const objects = createObjects();
        objects['zigbee.0.sensor.battery'].common.custom = { 'recorder.0': { enabled: true, mode: 'always' } };
        objects['zigbee.0.sensor.temperature'].common.custom = { 'recorder.0': { enabled: true, mode: 'exclude' } };
        const { selected } = computeSelection(objects, config({ includePatterns: ['zigbee.0.sensor.*'] }));
        assert.strictEqual(selected.get('zigbee.0.sensor.battery').reason, 'Custom: always');
        assert.ok(!selected.has('zigbee.0.sensor.temperature'));
    });

    it('applies the per-state filter and the automatic mode', () => {
        const objects = createObjects();
        const custom = settings => ({ 'recorder.0': { enabled: true, ...settings } });
        objects['zigbee.0.sensor.temperature'].common.custom = custom({ mode: 'auto', filter: 'all' });
        objects['zigbee.0.lamp.brightness'].common.custom = custom({ mode: 'always', filter: 'aggregate' });
        objects['0_userdata.0.counter'].common.custom = custom({ mode: 'auto', filter: 'all' });
        const { selected } = computeSelection(objects, config());

        const temperature = selected.get('zigbee.0.sensor.temperature');
        assert.strictEqual(temperature.cls, DpClass.Discrete);
        assert.ok(temperature.reason.startsWith('Type detector'), 'mode "auto" keeps the reason');
        assert.ok(temperature.reason.includes('every change'));
        assert.strictEqual(selected.get('zigbee.0.lamp.brightness').cls, DpClass.Aggregated);
        assert.ok(!selected.has('0_userdata.0.counter'), 'mode "auto" does not select');
    });

    it('classifies by the measured rate', () => {
        const rates = new Map([
            ['zigbee.0.sensor.temperature', { perMin: 12, maxPerMin: 12, high: true, ts: 0 }],
            ['zigbee.0.lamp.state', { perMin: 100, maxPerMin: 100, high: true, ts: 0 }],
            ['0_userdata.0.kitchenLight', { perMin: 10, maxPerMin: 10, high: true, ts: 0 }],
        ]);
        const { selected } = computeSelection(createObjects(), config({ rates, extremeRate: 60 }));
        const temperature = selected.get('zigbee.0.sensor.temperature');
        assert.strictEqual(temperature.cls, DpClass.Aggregated);
        assert.ok(temperature.reason.includes('12/min'), temperature.reason);
        assert.strictEqual(selected.get('zigbee.0.lamp.state').cls, DpClass.Discarded, 'a boolean at 100/min');
        assert.strictEqual(selected.get('0_userdata.0.kitchenLight').cls, DpClass.Discrete, 'below the extreme rate');
    });

    it('updates the detection incrementally with the same result as a full run', async () => {
        const objects = createObjects();
        const detection = new DeviceDetection('recorder.0');
        const keysOf = () => Object.keys(objects).sort();
        const first = await detection.update(objects, keysOf(), () => new Promise(r => setImmediate(r)));
        assert.ok(first.has('zigbee.0.lamp.brightness'));

        // a new sensor, a deleted lamp, a changed role
        objects['zigbee.0.new'] = { _id: 'zigbee.0.new', type: 'device', common: { name: 'new' }, native: {} };
        objects['zigbee.0.new.temperature'] = {
            _id: 'zigbee.0.new.temperature',
            type: 'state',
            common: { name: 't', role: 'value.temperature', type: 'number', read: true, write: false },
            native: {},
        };
        for (const id of ['zigbee.0.lamp', 'zigbee.0.lamp.state', 'zigbee.0.lamp.brightness']) {
            delete objects[id];
            detection.invalidate(id);
        }
        detection.invalidate('zigbee.0.new');
        detection.invalidate('zigbee.0.new.temperature');

        const incremental = detection.updateSync(objects, keysOf());
        const full = new DeviceDetection('recorder.0').updateSync(objects, keysOf());
        assert.deepStrictEqual([...incremental.entries()].sort(), [...full.entries()].sort());
        assert.ok(incremental.has('zigbee.0.new.temperature'));
        assert.ok(!incremental.has('zigbee.0.lamp.brightness'));
    });

    it('classifies roles', () => {
        assert.ok(isNegativeRole('button.stop'));
        assert.ok(isNegativeRole('indicator.reachable'));
        assert.ok(isNegativeRole('info.status'));
        assert.ok(!isNegativeRole('indicator.lowbat'));
        assert.strictEqual(categoryOfRole('value.temperature').key, 'climate');
        assert.strictEqual(categoryOfRole('value.power.consumption').key, 'energy');
        assert.strictEqual(categoryOfRole('value.temperatureX'), undefined);
    });
});
