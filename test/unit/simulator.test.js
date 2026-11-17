'use strict';

const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { SourceKind, DpClass } = require('../../build/lib/types');
const { PresenceSimulation, planSimulatedDay, renderPlan, switchableDps } = require('../../build/lib/simulator');

const MIN = 60_000;
// local times: Wednesday 2026-11-11 is played on Wednesday 2026-11-18
const at = (day, hours, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();
const SETTINGS = { weeks: 4, jitter: 0, sunset: false, media: false, scripts: false, dryRun: false };
const OWN = 'system.adapter.recorder.0';

function definition(oid, extra) {
    return {
        oid,
        name: oid.split('.').pop(),
        room: 'Wohnzimmer',
        func: null,
        role: 'switch.light',
        unit: null,
        devType: 'light',
        category: 'light',
        cls: DpClass.Discrete,
        type: 'boolean',
        states: null,
        ...extra,
    };
}

const settle = async () => {
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
};

/** The adapter as seen by the simulation, with a clock and timers of its own */
class FakeHost {
    constructor(storage, dps, commons) {
        this.time = 0;
        this.timers = [];
        this.writes = [];
        this.states = {};
        this.reports = [];
        this.logs = [];
        this.ownFrom = OWN;
        this._storage = storage;
        this._dps = dps;
        this._commons = commons;
        const log = level => text => this.logs.push(`${level}: ${text}`);
        this.log = {
            debug: log('debug'),
            info: log('info'),
            warn: log('warn'),
            error: log('error'),
            silly: log('silly'),
        };
    }
    storage() {
        return this._storage;
    }
    datapoints() {
        return this._dps;
    }
    common(oid) {
        return this._commons[oid];
    }
    async getState(oid) {
        return oid in this.states ? { val: this.states[oid], ack: true } : null;
    }
    async setState(oid, val) {
        this.writes.push({ ts: this.time, oid, val });
        this.states[oid] = val;
    }
    async report(status) {
        this.reports.push(status);
    }
    setTimeout(fn, ms) {
        const timer = { at: this.time + ms, fn };
        this.timers.push(timer);
        return timer;
    }
    clearTimeout(timer) {
        this.timers = this.timers.filter(t => t !== timer);
    }
    now() {
        return this.time;
    }
    random() {
        return 0.5;
    }
    /** Runs the timers until `to` */
    async advance(to) {
        for (;;) {
            const due = this.timers.filter(t => t.at <= to).sort((a, b) => a.at - b.at)[0];
            if (!due) {
                break;
            }
            this.timers = this.timers.filter(t => t !== due);
            this.time = due.at;
            due.fn();
            await settle();
        }
        this.time = to;
    }
}

describe('presence simulation: runner', () => {
    let dir;
    let storage;
    let host;
    let ceiling;
    let lamp;
    let blind;
    let socket;
    let thermostat;
    let user;
    let device;
    let own;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'recorder-sim-'));
        storage = new Storage(dir);
        storage.open();
        ceiling = storage.upsertDp(definition('hue.0.ceiling.on', { name: 'Decke' }));
        lamp = storage.upsertDp(
            definition('hue.0.lamp.level', { name: 'Stehlampe', role: 'level.dimmer', type: 'number', unit: '%' }),
        );
        blind = storage.upsertDp(
            definition('shelly.0.blind.level', {
                name: 'Rollladen',
                role: 'level.blind',
                type: 'number',
                devType: 'blind',
                category: 'shading',
                unit: '%',
            }),
        );
        socket = storage.upsertDp(
            definition('shelly.0.plug.on', {
                name: 'Steckdose',
                role: 'switch',
                devType: 'socket',
                category: 'sockets',
            }),
        );
        thermostat = storage.upsertDp(
            definition('hm.0.thermostat.set', {
                name: 'Heizung',
                role: 'level.temperature',
                type: 'number',
                devType: 'thermostat',
                category: 'climate',
            }),
        );
        user = storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User);
        device = storage.getSourceId('system.adapter.hue.0', undefined, SourceKind.Adapter);
        own = storage.getSourceId(OWN, undefined, SourceKind.Adapter);

        const ev = (ts, dp, val, src = user, ack = false) => ({ ts, dp: dp.id, val, sval: null, ack, src });
        const keyframe = ts => ({
            ts,
            rows: [ceiling, lamp, blind, socket, thermostat].map(dp => ({
                dp: dp.id,
                val: dp === blind ? 100 : 0,
                sval: null,
            })),
        });
        // Wednesday at home
        storage.write(
            [
                ev(at(11, 17), blind, 0),
                ev(at(11, 18), ceiling, 1),
                ev(at(11, 18) + 500, ceiling, 1, device, true),
                ev(at(11, 18, 5), socket, 1),
                ev(at(11, 19), thermostat, 23),
                ev(at(11, 21), lamp, 60),
                ev(at(11, 23), ceiling, 0, device, true), // switched off on the wall
                ev(at(12, 0, 30), lamp, 0),
                ev(at(12, 7), blind, 100),
            ],
            keyframe(at(11, 0)),
        );
        const dps = [ceiling, lamp, blind, socket, thermostat];
        const commons = Object.fromEntries(dps.map(dp => [dp.oid, { write: true, role: dp.role }]));
        host = new FakeHost(storage, dps, commons);
        host.states = {
            [ceiling.oid]: false,
            [lamp.oid]: 0,
            [blind.oid]: 100,
            [socket.oid]: false,
            [thermostat.oid]: 20,
        };
    });

    afterEach(() => {
        storage.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const switchable = () => switchableDps(host.datapoints(), oid => host.common(oid), false);

    it('plans only lights and blinds', () => {
        assert.deepStrictEqual(
            switchable().map(dp => dp.oid),
            [ceiling.oid, lamp.oid, blind.oid],
        );
        const plan = planSimulatedDay(storage, switchable(), at(18, 12), SETTINGS, () => 0);
        assert.strictEqual(plan.source, at(11, 12));
        assert.strictEqual(plan.sameWeekday, true);
        assert.deepStrictEqual(
            plan.actions.map(a => [a.ts, a.dp, a.val, a.kind]),
            [
                [at(18, 17), blind.id, 0, 'user'],
                [at(18, 18), ceiling.id, 1, 'user'],
                [at(18, 21), lamp.id, 60, 'user'],
                [at(18, 23), ceiling.id, 0, 'device'],
                [at(19, 0, 30), lamp.id, 0, 'user'],
                [at(19, 7), blind.id, 100, 'user'],
            ],
        );
        const html = renderPlan(plan, storage, 3, false, at(18, 20), 'de');
        assert.ok(html.includes('Rollladen') && html.includes('Stehlampe'));
        assert.ok(!html.includes('>Steckdose<') && !html.includes('>Heizung<'));
        assert.ok(html.includes('opacity'), 'the past is grey');
    });

    it('has no plan without a day at home', () => {
        const plan = planSimulatedDay(storage, switchable(), at(11, 12), SETTINGS, () => 0);
        assert.strictEqual(plan.source, null);
        assert.ok(renderPlan(plan, storage, 3, false, at(11, 13), 'en').includes('No day at home'));
    });

    it('switches at the planned times and stops at once', async () => {
        host.time = at(18, 13);
        const simulation = new PresenceSimulation(host, { ...SETTINGS }, 'en');
        await simulation.start('test');
        assert.ok(simulation.running);
        assert.strictEqual(host.reports.at(-1).sourceDay, '2026-11-11');
        assert.ok(host.reports.at(-1).nextAction.startsWith('17:00 Wohnzimmer Rollladen: 0'));

        await host.advance(at(18, 21, 30));
        assert.deepStrictEqual(host.writes, [
            { ts: at(18, 17), oid: blind.oid, val: 0 },
            { ts: at(18, 18), oid: ceiling.oid, val: true },
            { ts: at(18, 21), oid: lamp.oid, val: 60 },
        ]);
        assert.strictEqual(host.reports.at(-1).lastAction, '21:00 Wohnzimmer Stehlampe: 60 %');

        host.writes = [];
        const stopping = simulation.stop('test');
        // before anything is awaited
        assert.strictEqual(host.timers.length, 0);
        assert.ok(!simulation.running);
        await stopping;
        // the lights it switched on are off, the blind stays
        assert.deepStrictEqual(
            host.writes.map(w => [w.oid, w.val]),
            [
                [ceiling.oid, false],
                [lamp.oid, 0],
            ],
        );
        assert.strictEqual(host.reports.at(-1).active, false);
        await host.advance(at(19, 12));
        assert.strictEqual(host.writes.length, 2, 'nothing after the stop');
    });

    it('does not catch up the past and skips what is already so', async () => {
        host.time = at(18, 20);
        host.states[ceiling.oid] = true;
        host.states[lamp.oid] = 60;
        const simulation = new PresenceSimulation(host, { ...SETTINGS }, 'en');
        await simulation.start('test');
        await host.advance(at(18, 22));
        await simulation.stop('test');
        // nothing of 17:00 and 18:00; the lamp was at 60 already; neither light was switched on by the simulation
        assert.deepStrictEqual(host.writes, []);
    });

    it('plays the next day at noon and switches off what is off there', async () => {
        // on Thursday morning the ceiling light went on again
        storage.write([{ ts: at(12, 11), dp: ceiling.id, val: 1, sval: null, ack: false, src: user }]);
        host.time = at(18, 13);
        const simulation = new PresenceSimulation(host, { ...SETTINGS }, 'en');
        await simulation.start('test');
        await host.advance(at(19, 11, 30));
        assert.deepStrictEqual(
            host.writes.map(w => [w.oid, w.val]),
            [
                [blind.oid, 0],
                [ceiling.oid, true],
                [lamp.oid, 60],
                [ceiling.oid, false],
                [lamp.oid, 0],
                [blind.oid, 100],
                [ceiling.oid, true],
            ],
        );
        host.writes = [];
        // Thursday 2026-11-12 was not at home: another day is played, which starts with the light off
        await host.advance(at(19, 12, 30));
        assert.deepStrictEqual(
            host.writes.map(w => [w.ts, w.oid, w.val]),
            [[at(19, 12), ceiling.oid, false]],
        );
        assert.ok(simulation.running);
        assert.strictEqual(simulation.currentPlan.start, at(19, 12));
        assert.strictEqual(simulation.currentPlan.source, at(11, 12), 'the only day at home');
        assert.strictEqual(simulation.currentPlan.sameWeekday, false);
        await simulation.stop('test');
    });

    it('only logs in a dry run', async () => {
        host.time = at(18, 13);
        const simulation = new PresenceSimulation(host, { ...SETTINGS, dryRun: true }, 'en');
        await simulation.start('test');
        await host.advance(at(18, 22));
        await simulation.stop('test');
        assert.deepStrictEqual(host.writes, []);
        assert.ok(host.logs.some(l => l.includes('(dry run): 18:00 Wohnzimmer Decke: on')));
    });

    it('skips actions that are long overdue (a suspended system)', async () => {
        host.time = at(18, 13);
        const simulation = new PresenceSimulation(host, { ...SETTINGS }, 'en');
        await simulation.start('test');
        // the timer fires an hour late
        host.timers.forEach(t => (t.at = at(18, 18, 30)));
        await host.advance(at(18, 18, 30));
        assert.deepStrictEqual(host.writes, []);
        await simulation.stop('test');
    });

    it('finds the lights it switched on before a restart', async () => {
        host.time = at(18, 20);
        storage.write([{ ts: at(18, 19), dp: ceiling.id, val: 1, sval: null, ack: false, src: own }]);
        host.states[ceiling.oid] = true;
        host.states[lamp.oid] = 30; // switched on by somebody else
        const simulation = new PresenceSimulation(host, { ...SETTINGS }, 'en');
        await simulation.finishAfterRestart('test');
        assert.deepStrictEqual(
            host.writes.map(w => [w.oid, w.val]),
            [[ceiling.oid, false]],
        );
        assert.ok(!simulation.running);
    });
});
