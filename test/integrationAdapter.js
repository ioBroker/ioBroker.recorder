'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { tests } = require('@iobroker/testing');

const TEST_ID = '0_userdata.0.recorderTest';
const TEMP_ID = '0_userdata.0.recorderTemperature';
const AWAY_ID = '0_userdata.0.recorderAway';

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls a state until `check(state)` is true or the timeout expires */
async function waitForState(harness, id, check, timeout = 10_000) {
    const end = Date.now() + timeout;
    let state;
    while (Date.now() < end) {
        state = await harness.states.getStateAsync(id);
        if (check(state)) {
            return state;
        }
        await wait(200);
    }
    return state;
}

// Run tests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Recording', getHarness => {
            it('records real changes and ignores timestamp-only updates', async function () {
                this.timeout(45_000);
                const harness = getHarness();

                await harness.objects.setObjectAsync(TEST_ID, {
                    type: 'state',
                    common: { name: 'Recorder test', type: 'number', role: 'value', read: true, write: true },
                    native: {},
                });
                await harness.states.setStateAsync(TEST_ID, { val: 0, ack: true });
                await harness.objects.setObjectAsync(TEMP_ID, {
                    type: 'state',
                    common: { name: 'Temperature', type: 'number', role: 'value.temperature', read: true, write: true },
                    native: {},
                });
                await harness.states.setStateAsync(TEMP_ID, { val: 20, ack: true });
                await harness.objects.setObjectAsync(AWAY_ID, {
                    type: 'state',
                    common: { name: 'Away', type: 'boolean', role: 'state', read: true, write: true },
                    native: {},
                });
                await harness.states.setStateAsync(AWAY_ID, { val: false, ack: true });
                await harness.changeAdapterConfig('recorder', {
                    native: {
                        includePatterns: [TEST_ID, TEMP_ID],
                        excludePatterns: [],
                        flushInterval: 1,
                        retentionDays: 7,
                        mirrorStates: true,
                        simulation: true,
                        simTrigger: AWAY_ID,
                        // every change of "value", a dead band of 0.2 without delay for the temperature
                        roleRules: [
                            { role: 'value', deadband: 0, relative: false, minInterval: 0, heartbeat: 0 },
                            { role: 'value.temperature', deadband: 0.2, relative: false, minInterval: 0, heartbeat: 0 },
                        ],
                    },
                });
                const startedAt = Date.now();
                await harness.startAdapterAndWait();

                const count = await waitForState(harness, 'recorder.0.info.recordedCount', s => s?.val === 2);
                assert.strictEqual(count?.val, 2, 'two states must be selected');
                // the test directory survives between runs: today's events of earlier runs are counted too
                const before = await waitForState(harness, 'recorder.0.info.eventsToday', s => s?.ts >= startedAt);
                const baseline = before?.val || 0;

                const setAt = [];
                for (const val of [1, 2, 2, 3]) {
                    // the second 2 is an update without a change and must not be recorded
                    await harness.states.setStateAsync(TEST_ID, { val, ack: true });
                    setAt.push(Date.now());
                    await wait(50);
                }
                for (const val of [20.1, 20.3, 20.4, 21]) {
                    // the dead band of 0.2 keeps 20.3 and 21
                    await harness.states.setStateAsync(TEMP_ID, { val, ack: true });
                    await wait(50);
                }

                const events = await waitForState(harness, 'recorder.0.info.eventsToday', s => s?.val >= baseline + 5);
                if (events?.val !== baseline + 5) {
                    const read = id =>
                        new Promise(resolve =>
                            harness.sendTo(
                                'recorder.0',
                                'getHistory',
                                { id, options: { start: startedAt - 60_000, aggregate: 'none' } },
                                resolve,
                            ),
                        );
                    const recorded = [];
                    for (const id of [TEST_ID, TEMP_ID]) {
                        recorded.push(`${id}: ${JSON.stringify((await read(id)).result)}`);
                    }
                    assert.fail(`five changes must be recorded, got ${events?.val - baseline}: ${recorded.join('; ')}`);
                }

                const size = await harness.states.getStateAsync('recorder.0.info.dbSize');
                assert.ok(size?.val > 0, 'the database must exist');

                const selection = await new Promise(resolve =>
                    harness.sendTo('recorder.0', 'getSelection', null, resolve),
                );
                const entry = selection.find(s => s.id === TEST_ID);
                assert.ok(entry, 'getSelection must list the test state');
                assert.strictEqual(entry.reason, 'Include rule');

                const preview = await new Promise(resolve =>
                    harness.sendTo('recorder.0', 'previewSelection', { includePatterns: [] }, resolve),
                );
                assert.strictEqual(typeof preview.text, 'string');
                assert.ok(preview.text.includes('<table'), 'the preview is an HTML table');
                assert.ok(!preview.text.includes(TEST_ID), 'without the include rule the state is not selected');

                // the commands of history, sql and influxdb
                const sendTo = (command, message) =>
                    new Promise(resolve => harness.sendTo('recorder.0', command, message, resolve));
                const history = await sendTo('getHistory', {
                    id: TEST_ID,
                    options: { start: startedAt, aggregate: 'none', from: true, ack: true, removeBorderValues: true },
                });
                assert.ok(!history.error, history.error);
                assert.deepStrictEqual(
                    history.result.map(e => e.val).slice(-3),
                    [1, 2, 3],
                    'getHistory must return the recorded changes',
                );
                assert.strictEqual(history.result[history.result.length - 1].ack, true);

                const average = await sendTo('getHistory', {
                    id: TEST_ID,
                    options: { start: startedAt, end: Date.now() + 1000, aggregate: 'max', count: 1 },
                });
                assert.ok(!average.error, average.error);
                assert.ok(
                    average.result.some(e => e.val === 3),
                    `the aggregation must find the maximum: ${JSON.stringify(average.result)}`,
                );

                const temperature = await sendTo('getHistory', {
                    id: TEMP_ID,
                    options: { start: startedAt, aggregate: 'none', removeBorderValues: true },
                });
                assert.deepStrictEqual(
                    temperature.result.map(e => e.val).slice(-2),
                    [20.3, 21],
                    'the dead band must drop 20.1 and 20.4',
                );

                const highFrequency = await sendTo('getHighFrequency', null);
                assert.strictEqual(typeof highFrequency.text, 'string');

                const features = await sendTo('features', null);
                assert.deepStrictEqual(features.supportedFeatures, []);
                const enabled = await sendTo('getEnabledDPs', null);
                assert.strictEqual(enabled[TEST_ID]?.enabled, true);

                // walk into the past
                const now = await sendTo('getSnapshot', {});
                assert.ok(!now.error, now.error);
                assert.strictEqual(now.states.find(s => s.id === TEST_ID)?.val, 3);
                assert.strictEqual(now.states.find(s => s.id === TEMP_ID)?.val, 21);
                const past = await sendTo('getSnapshot', { ts: setAt[0] + 20 });
                assert.strictEqual(past.states.find(s => s.id === TEST_ID)?.val, 1, 'the value after the first change');
                const atKeyframe = await sendTo('getSnapshot', { ts: setAt[0] - 20 });
                assert.strictEqual(atKeyframe.states.find(s => s.id === TEST_ID)?.val, 0, 'the value of the keyframe');

                const journal = await sendTo('getEvents', { start: startedAt, ids: TEST_ID });
                assert.ok(!journal.error, journal.error);
                assert.deepStrictEqual(
                    journal.events.map(e => e.val),
                    [1, 2, 3],
                );
                assert.strictEqual(journal.events[0].name, 'Recorder test');
                const timeline = await sendTo('getTimeline', { start: startedAt, buckets: 10 });
                assert.ok(!timeline.error, timeline.error);
                assert.ok(timeline.counts.reduce((a, b) => a + b, 0) >= 5, JSON.stringify(timeline));

                // replay into the mirror states
                const mirror = 'recorder.0.mirror.0_userdata_0_recorderTest';
                assert.ok(await harness.objects.getObjectAsync(mirror), 'the mirror state must exist');
                await harness.states.setStateAsync('recorder.0.replay.time', { val: setAt[0] + 20, ack: false });
                const jumped = await waitForState(harness, mirror, s => s?.val === 1);
                assert.strictEqual(jumped?.val, 1, 'a jump writes the snapshot into the mirrors');
                await harness.states.setStateAsync('recorder.0.replay.speed', { val: 600, ack: false });
                await harness.states.setStateAsync('recorder.0.replay.active', { val: true, ack: false });
                const ended = await waitForState(
                    harness,
                    'recorder.0.replay.active',
                    s => s?.ack && s.val === false && s.ts > setAt[3],
                );
                assert.strictEqual(ended?.val, false, 'the replay stops at the present');
                assert.strictEqual(
                    (await harness.states.getStateAsync(mirror))?.val,
                    3,
                    'the replay wrote the changes',
                );

                // presence simulation: no day at home is recorded, but the trigger starts and stops it
                const plan = await sendTo('getSimulationPlan', { simWeeks: 2 });
                assert.strictEqual(typeof plan.text, 'string', JSON.stringify(plan));
                assert.strictEqual(plan.source, null, 'no day at home recorded yet');
                await harness.states.setStateAsync(AWAY_ID, { val: true, ack: true });
                const started = await waitForState(harness, 'recorder.0.simulation.enabled', s => s?.val === true);
                assert.strictEqual(started?.val, true, 'absence starts the simulation');
                const homeAt = Date.now();
                await harness.states.setStateAsync(AWAY_ID, { val: false, ack: true });
                const stopped = await waitForState(harness, 'recorder.0.simulation.enabled', s => s?.val === false);
                assert.strictEqual(stopped?.val, false, 'presence stops the simulation');
                assert.ok(stopped.ts - homeAt < 1000, `stopped after ${stopped.ts - homeAt} ms`);

                // anomaly detection: still learning, nothing open
                const info = await sendTo('getAnomalyInfo', null);
                assert.ok(info.text.includes('<'), JSON.stringify(info));
                const anomalies = await sendTo('getAnomalies', { open: true });
                assert.deepStrictEqual(anomalies.anomalies, []);
                const profile = await sendTo('getProfile', { id: TEMP_ID });
                assert.strictEqual(profile.learned, false, JSON.stringify(profile));
                assert.ok(Array.isArray(profile.profile));
                const ack = await sendTo('ackAnomaly', {});
                assert.strictEqual(ack.count, 0);
                const active = await harness.states.getStateAsync('recorder.0.anomaly.active');
                assert.strictEqual(active?.val, false);
            });
        });
    },
});
