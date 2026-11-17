'use strict';

/**
 * Load test of the storage layer (acceptance of milestone 1):
 * generates synthetic changes in real time, buffers them like the adapter and writes them in
 * batches. At the end it checks that every event arrived and prints the CPU load.
 *
 *   npm run build
 *   node test/bench/load.js [--rate 10000] [--seconds 60] [--dps 2000] [--flush 30] [--keep]
 *
 * --rate     events per minute
 * --seconds  duration of the test
 * --dps      number of datapoints
 * --flush    write interval in seconds
 * --keep     do not delete the database afterwards
 *
 * It measures the storage path (encoding, buffer, SQLite). The cost of the subscriptions in
 * js-controller is not included; it has to be measured on a real system.
 */
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir, cpus } = require('node:os');
const { join } = require('node:path');

const { Storage } = require('../../build/lib/storage');
const { encodeValue } = require('../../build/lib/values');
const { SourceKind, DpClass } = require('../../build/lib/types');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const RATE = arg('rate', 10_000);
const SECONDS = arg('seconds', 60);
const DPS = arg('dps', 2_000);
const FLUSH = arg('flush', 30);
const KEEP = process.argv.includes('--keep');
const TICK = 10; // ms

const dir = mkdtempSync(join(tmpdir(), 'recorder-bench-'));
const storage = new Storage(dir);
storage.open();

const dps = [];
for (let i = 0; i < DPS; i++) {
    const type = i % 3 === 0 ? 'boolean' : 'number';
    dps.push(
        storage.upsertDp({
            oid: `bench.0.device${Math.floor(i / 10)}.dp${i}`,
            name: `Datapoint ${i}`,
            room: null,
            func: null,
            role: type === 'boolean' ? 'switch' : 'value.temperature',
            unit: null,
            devType: null,
            category: null,
            cls: type === 'boolean' ? DpClass.Discrete : DpClass.Continuous,
            type,
            states: null,
        }),
    );
}
const sources = [
    storage.getSourceId('system.adapter.zigbee.0', undefined, SourceKind.Adapter),
    storage.getSourceId('system.adapter.vis-2.0', 'system.user.admin', SourceKind.User),
    storage.getSourceId('system.adapter.javascript.0', 'system.user.admin', SourceKind.Script),
];

let buffer = [];
let generated = 0;
let carry = 0;
const flushTimes = [];

function flush(keyframe) {
    const start = process.hrtime.bigint();
    const events = buffer;
    buffer = [];
    storage.write(events, keyframe);
    flushTimes.push({ ms: Number(process.hrtime.bigint() - start) / 1e6, n: events.length });
}

const startWall = Date.now();
const startCpu = process.cpuUsage();
let lastTick = startWall;

const tick = setInterval(() => {
    // timers are coarse (about 15 ms on Windows): generate by the time that really passed
    const now = Date.now();
    carry += (RATE / 60_000) * (now - lastTick);
    lastTick = now;
    const n = Math.floor(carry);
    carry -= n;
    for (let i = 0; i < n; i++) {
        const dp = dps[Math.floor(Math.random() * dps.length)];
        const value = dp.type === 'boolean' ? Math.random() < 0.5 : Math.round(Math.random() * 300) / 10;
        const stored = encodeValue(value, dp.type);
        buffer.push({ ts: now, dp: dp.id, val: stored.val, sval: stored.sval, ack: true, src: sources[i % 3] });
        generated++;
    }
}, TICK);

const flushTimer = setInterval(() => flush(), FLUSH * 1000);

setTimeout(() => {
    clearInterval(tick);
    clearInterval(flushTimer);
    // keyframe with the current state of all datapoints, like at every full hour
    flush({ ts: Date.now(), rows: dps.map(dp => ({ dp: dp.id, val: 1, sval: null })) });

    const wall = Date.now() - startWall;
    const cpu = process.cpuUsage(startCpu);
    const stored = storage.countEvents(0, Date.now() + 1);
    const size = storage.sizeBytes();
    storage.close();
    const files = require('node:fs')
        .readdirSync(dir)
        .map(f => `${f} ${(require('node:fs').statSync(join(dir, f)).size / 1024).toFixed(0)} kB`);
    if (!KEEP) {
        rmSync(dir, { recursive: true, force: true });
    }

    const writes = flushTimes.filter(f => f.n);
    const max = Math.max(...writes.map(f => f.ms));
    const avg = writes.reduce((s, f) => s + f.ms, 0) / (writes.length || 1);
    const cpuPercent = ((cpu.user + cpu.system) / 1000 / wall) * 100;

    console.log(`CPU:            ${cpus()[0]?.model ?? 'unknown'} (${process.platform}, node ${process.version})`);
    console.log(`Rate:           ${RATE} events/min, ${DPS} datapoints, ${SECONDS} s, write every ${FLUSH} s`);
    console.log(`Generated:      ${generated}`);
    console.log(`Stored:         ${stored}`);
    console.log(`Writes:         ${writes.length}, avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    console.log(`CPU load:       ${cpuPercent.toFixed(2)} % of one core (incl. generator)`);
    console.log(`Database size:  ${(size / 1_048_576).toFixed(2)} MB while open${KEEP ? ` in ${dir}` : ''}`);
    console.log(`Files closed:   ${files.join(', ')}`);

    if (stored !== generated) {
        console.error(`FAILED: ${generated - stored} events lost`);
        process.exit(1);
    }
    console.log('OK: no events lost');
}, SECONDS * 1000);
