![Logo](admin/recorder.svg)
# ioBroker.recorder

[![NPM version](https://img.shields.io/npm/v/iobroker.recorder.svg)](https://www.npmjs.com/package/iobroker.recorder)
[![Downloads](https://img.shields.io/npm/dm/iobroker.recorder.svg)](https://www.npmjs.com/package/iobroker.recorder)
![Test and Release](https://github.com/ioBroker/ioBroker.recorder/workflows/Test%20and%20Release/badge.svg)

Records all relevant states of an ioBroker installation for a configurable period (a day, a week,
a month) - without configuring every single state - and builds three features on top of it:

- **Walk into the past**: the state of the whole house at any moment, replayable
- **Presence simulation**: replays the manual switching of lights and blinds from a past day
- **Anomaly detection**: values and activities that do not fit the usual weekly pattern

> **Status:** early development. All six milestones of the plan are implemented; the long-term
> tests on real installations are still running.

Deutsche Dokumentation: [docs/de/README.md](docs/de/README.md)

## Selection of the states

The states are selected automatically in four steps; a later one overrides an earlier one:

1. The type detector recognizes devices (light, blind, thermostat, window ...) and the meaning of
   their states. Only meaningful states are taken: no battery, signal strength or reachability.
2. Optionally only states in a room or function.
3. For states without a recognized device the role decides (e.g. `value.temperature`).
4. Include and exclude patterns, and per state "always record" / "never record" in the object
   browser (custom settings).

The categories light, shading, heating and climate, windows and doors, security, switches and
sockets, media, weather and energy can each be switched off, recorded or aggregated to 5 minute
values. Motion and presence are **off** by default for privacy; energy is aggregated by default.

The tab "Preview" in the instance settings shows which states would be recorded, with the reason
and a size estimate, before the settings are saved.

## Frequency filter

Not every change is worth storing. Each recorded state gets a class:

- **discrete** (switches, contacts, states with a list of values): every change
- **continuous** (numbers): stored when the value changes by at least the dead band, at most once
  per minimum interval (then the latest value), and small changes after the heartbeat
- **aggregated** (energy, and numbers that change more than 6 times per minute on average of an
  hour): 5 minute aggregates (min, max, mean, last)
- **discarded**: other states that change more than 60 times per minute on average

| Role                                      | Dead band  | Min. interval  | Heartbeat  |
|-------------------------------------------|------------|----------------|------------|
| `value.temperature`, `level.temperature`  | 0.2        | 60 s           | 1 h        |
| `value.humidity`                          | 2          | 60 s           | 1 h        |
| `value.brightness`                        | 10 %       | 60 s           | 1 h        |
| `level.dimmer`, `level.blind`             | 1          | 0 s            | none       |
| `value.power`                             | 5 %        | 60 s           | 15 min     |
| other numbers                             | 1 %        | 60 s           | 1 h        |

The tab "Rules" overrides these values per role. A state that suddenly changes more than 60 times
per minute (a defective sensor) is throttled and reported in the log. The tab "High frequency"
lists the measured rates. Per state, "Filter" in the object browser can force "every change" or
"aggregate".

## Reading the data

`getHistory` works like with `history`, `sql` and `influxdb` (same options, same aggregation by
`@iobroker/aggregate`), so charts and scripts can use the recorder as a source:

```js
sendTo('recorder.0', 'getHistory', {
    id: 'hm-rpc.0.ABC.1.LEVEL',
    options: { start: Date.now() - 86400000, aggregate: 'none', from: true },
}, result => console.log(result.result));
```

Datapoints that are aggregated to 5 minutes (energy) return one value per interval. `from: true` also
returns `from` and `user`, `comment: true` (as with `history`) returns `c`: the script that changed the
value (javascript writes it into `state.c`, e.g. `script.js.common.Light`).
`enableHistory` / `disableHistory` set "always record" / "never record" for a state.

## Walk into the past

The admin tab **Time machine** shows the state of every room at any moment of the recorded period:

- a timeline with the density of the changes; drag it, click it or use the arrow keys
- play / pause with 1x, 10x, 60x, 600x or 3600x speed
- tiles per room with lights, windows, climate, blinds ... and the journal of the changes before the
  cursor ("07:12 Bath · Light **on** (admin)")
- filters for room, category and "manual actions only"

**Replay into states:** `recorder.0.replay.time` (writable: jump), `recorder.0.replay.speed` and
`recorder.0.replay.active` play the past in the instance itself. With "Mirror states for the replay"
enabled, every recorded state gets a read-only copy `recorder.0.mirror.<id with _>` that shows the
replayed value, so a vis project can show the past without touching the real devices.

### Messages for scripts, vis and the MCP server

The tab uses three messages, which are available to everybody:

| Message       | Answers the question                                | Result                          |
|---------------|-----------------------------------------------------|---------------------------------|
| `getSnapshot` | What was the state of the house at time T?          | one value per datapoint         |
| `getEvents`   | What changed between A and B, and who changed it?   | list of changes (journal)       |
| `getTimeline` | When was there how much activity?                   | number of changes per interval  |

#### Common rules

**Call** from the javascript adapter with a callback or with `sendToAsync`, from a browser with
`socket.sendTo('recorder.0', ...)`, from the MCP server with `send_to`:

```js
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-16T20:00' }, answer => { /* ... */ });
const answer = await sendToAsync('recorder.0', 'getEvents', { src: 'user' });
```

**Times** (`ts`, `start`, `end`): milliseconds since 1970, a number as string, or anything
`new Date()` understands, e.g. `'2026-11-16T20:00'`. Without a time zone this is the **local time of
the ioBroker host**.

**Filters** (all three messages; each takes a single value or an array):

| Filter     | Meaning                                                                                                              | Comparison                                                         |
|------------|----------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `room`     | name of the room enum in the system language, e.g. `'Living room'`                                                   | case-insensitive; a datapoint in several rooms matches each of them |
| `category` | `light`, `shading`, `climate`, `windowsDoors`, `motion`, `security`, `sockets`, `media`, `weather`, `energy`          | case-insensitive                                                   |
| `ids`      | object IDs                                                                                                           | exact                                                              |
| `src`      | `user`, `script`, `adapter`, `system` (only `getEvents` and `getTimeline`)                                           |                                                                    |

The values of one filter are combined with OR (`room: ['Bath', 'Kitchen']`), different filters with
AND (`room: 'Bath', category: 'light'` returns only the lights in the bath).

**Sources** (`src`) are derived from `state.from`:

| `src`     | `from` is ...                                                                                                                         |
|-----------|---------------------------------------------------------------------------------------------------------------------------------------|
| `user`    | a user interface or a voice or chat channel: admin, web, vis, vis-2, material, iqontrol, jarvis, lovelace, cloud, iot, alexa2, matter, telegram, mcp, rest-api ... |
| `script`  | javascript, scenes, node-red, scheduler, alarm, flow, ai-server                                                                       |
| `adapter` | every other adapter, i.e. the device adapters (hm-rpc, zigbee, shelly ...)                                                            |
| `system`  | `system.host.*` or unknown                                                                                                            |

A switch pressed **on the wall** arrives as a confirmation (`ack: true`) of the device adapter and
therefore has `src: 'adapter'`, not `user`.

**Answers** always contain `ms` (time to compute the answer). On an error the answer is
`{ error: '...' }`, e.g. `'The instance is not ready yet'` right after the start.

**Master data**: `name`, `room`, `category` and `unit` are the *current* ones. A device renamed or
moved to another room since then appears with its new name and room.

#### `getSnapshot`: the state at one moment

Request: `{ ts?, room?, category?, ids? }`. `ts` defaults to now; a time in the future is set to now.

How it is computed:

1. Every full hour (and at the start) the instance writes a **keyframe** with the values of all
   recorded datapoints. The newest keyframe at or before `ts` is the base.
2. All stored changes in (keyframe, `ts`] are applied on top, including the buffer that is not
   written yet.
3. Datapoints of class "aggregated" (high-frequency, e.g. power) take the `last` value of the newest
   **finished** 5 minute interval before `ts`.

So at most about one hour of changes is read; measured: about 15 ms for 1,000 datapoints.

Answer:

```ts
{
    ts: number,               // the requested time (at most now)
    keyframe: number | null,  // time of the keyframe used; null: nothing was recorded before ts
    states: [{
        id, name, room, func, category, role, unit,
        val,                  // value with its type (boolean, number, string)
        text?,                // text from common.states, e.g. 'open' for 2
        lc: number | null,    // time of the change if it lies between keyframe and ts, else null
        ack?, from?, user?, c?, src?, // only if lc is set (the value comes from a change)
        aggregated?: true,    // last value of a 5 minute interval
    }],                       // sorted by id
    ms: number,
}
```

Good to know:

- **`lc: null` does not mean "never changed"**, only "not changed since the keyframe before" (at most
  about one hour before `ts`). When the value really changed last is answered by `getHistory` or by
  `getEvents` with a longer period.
- The value of an aggregated datapoint can be up to 5 minutes old; its `lc` is the end of the interval.
- `getSnapshot` has no `src` filter: a snapshot is a state, not a list of actions.
- `keyframe: null` with empty `states`: `ts` lies before the start of the recording or before the
  retention limit.

```js
// which lights were on yesterday at 23:00?
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-18T23:00', category: 'light' }, a => {
    const on = a.states.filter(s => s.val === true || (typeof s.val === 'number' && s.val > 0));
    log(on.map(s => `${s.room}: ${s.name}`).join('\n'));
});

// were windows open at 2 am? (true or 1/2 = tilted/open)
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-19T02:00', category: 'windowsDoors' }, a =>
    log(a.states
        .filter(s => s.val === true || (typeof s.val === 'number' && s.val > 0))
        .map(s => `${s.room} ${s.name}: ${s.text ?? s.val}`)));

// what was different at 18:00 compared to 08:00?
const morning = await sendToAsync('recorder.0', 'getSnapshot', { ts: '2026-11-19T08:00' });
const evening = await sendToAsync('recorder.0', 'getSnapshot', { ts: '2026-11-19T18:00' });
const before = new Map(morning.states.map(s => [s.id, s.val]));
for (const s of evening.states) {
    if (before.get(s.id) !== s.val) {
        log(`${s.name}: ${before.get(s.id)} -> ${s.val}`);
    }
}
```

#### `getEvents`: the changes in a period

Request:

```ts
{
    start?,     // default: end - 1 hour
    end?,       // default: now
    room?, category?, ids?,
    src?,       // e.g. 'user' for manual actions only
    limit?,     // default 1000, at most 10000
    newest?,    // with more than limit changes: the newest ones instead of the oldest
}
```

The period includes both borders, [start, end]; swapped borders are swapped back.

Answer:

```ts
{
    events: [{
        ts, id, name, room, category, role, unit,
        val, text?,
        ack: boolean,   // false: command, true: confirmation or measurement of the device
        from?, user?,   // e.g. 'system.adapter.vis-2.0', 'system.user.admin'
        c?,             // src script only: the script, e.g. 'script.js.common.Light' (javascript)
        src,            // user | script | adapter | system
    }],
    more: boolean,      // there were more than limit changes
    ms: number,
}
```

`events` is **always sorted oldest first**, also with `newest: true`; `newest` only decides which
`limit` changes are returned.

Good to know:

- **Command and confirmation are two entries.** A light switched from vis gives one entry with
  `ack: false, src: 'user'` (vis) and shortly after one with `ack: true, src: 'adapter'` (device
  adapter). With `src: 'user'` only the command remains.
- **Wall switches** are confirmations without a command before (`ack: true`, `src: 'adapter'`). To
  include them, ask for `src: ['user', 'adapter']` and evaluate the entries yourself.
- **Aggregated datapoints** (power, energy, very frequent sensors) have no single changes and are not
  listed; use `getHistory` for them.
- Only what the **frequency filter** let through is stored: small changes of a temperature within
  the dead band are missing.
- **Paging**: with `more: true` request the next page with `start` = the last `ts`; entries with
  exactly that `ts` come twice and must be skipped. Or make the period shorter.

```js
// what was switched by hand in the last 24 hours?
sendTo('recorder.0', 'getEvents', { start: Date.now() - 86400000, src: 'user' }, a => {
    for (const e of a.events) {
        log(`${new Date(e.ts).toLocaleTimeString()} ${e.room ?? ''} · ${e.name}: ${e.text ?? e.val} (${e.from})`);
    }
});

// the last 20 changes in the bath
sendTo('recorder.0', 'getEvents',
    { start: Date.now() - 7 * 86400000, room: 'Bath', limit: 20, newest: true }, a => log(a.events));

// who opened or locked the front door yesterday evening?
sendTo('recorder.0', 'getEvents', {
    start: '2026-11-18T18:00',
    end: '2026-11-18T23:59',
    ids: ['hm-rpc.0.ABC123.1.STATE', 'nuki.0.door.lockState'],
}, a => log(a.events.map(e => `${e.ts} ${e.name}=${e.val} ack=${e.ack} ${e.from} ${e.user ?? ''}`)));
```

#### `getTimeline`: the density of the changes

Request: `{ start?, end?, buckets?, room?, category?, ids?, src? }`. `end` defaults to now, `start` to
`end` - 24 hours, `buckets` to 100 (at most 2000).

Answer:

```ts
{
    start: number,
    end: number,          // = start + step * buckets (can be a little after the requested end)
    step: number,         // length of one interval in ms = ceil((end - start) / buckets), at least 1000
    counts: number[],     // buckets entries; counts[i] is for [start + i * step, start + (i + 1) * step)
    first: number | null, // the oldest recorded time (keyframe or change)
    ms: number,
}
```

Good to know:

- Only changes **already written** are counted: the buffer of the last up to 30 s (`flushInterval`)
  is missing at the right edge, and aggregated datapoints do not count.
- `first` does not depend on the filters; it is the left border of a timeline or slider ("recorded
  since ...").
- Typical use: find the peaks with `getTimeline`, then get the details of interval `i` with
  `getEvents`: `start: t.start + i * t.step, end: t.start + (i + 1) * t.step - 1`.

```js
// activity per hour in the last 7 days, motion only
sendTo('recorder.0', 'getTimeline',
    { start: Date.now() - 7 * 86400000, buckets: 168, category: 'motion' }, t => {
    t.counts.forEach((n, i) => n && log(`${new Date(t.start + i * t.step).toLocaleString()}: ${n}`));
});

// the busiest quarter of an hour of last night, and what happened then
const t = await sendToAsync('recorder.0', 'getTimeline',
    { start: '2026-11-18T22:00', end: '2026-11-19T06:00', buckets: 32 });
const i = t.counts.indexOf(Math.max(...t.counts));
const a = await sendToAsync('recorder.0', 'getEvents',
    { start: t.start + i * t.step, end: t.start + (i + 1) * t.step - 1 });
log(a.events);
```

#### Which message for what?

| Question                                                                   | Message                                                                     |
|----------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| "What did it look like at 20:00?", a state of the house for a vis          | `getSnapshot`                                                               |
| "What happened, and who did it?", a log, questions to an AI                | `getEvents`                                                                 |
| a timeline, an overview of the activity                                    | `getTimeline`                                                               |
| the course of one value for a chart, aggregated values                     | `getHistory`                                                                |
| play the past **into states** (a vis without a script of its own)          | `replay.time` / `replay.speed` / `replay.active` with the mirror states     |

## Presence simulation

While nobody is at home, the instance plays the switching of lights and blinds of a recorded day on
which somebody was at home. Enable it in the tab "Presence simulation" of the instance settings.

- **Start and stop**: a state that reports absence (e.g. `0_userdata.0.away` or an armed alarm
  system; "The state reports presence" for a state that is `true` at home), or
  `recorder.0.simulation.enabled` by hand, from a script or a vis. The end of the absence stops the
  simulation at once: nothing is caught up, and the lights and media it switched on are switched off.
- **What is played**: at random one of the same weekdays 1 to 4 weeks back on which lights or blinds
  were switched at least 3 times; if there is none, another day at home. A simulated day runs from
  noon to noon, so the evening and the switching off at night come from the same recorded day.
- **Who switched**: only persons - commands from user interfaces (admin, vis, apps, voice
  assistants, Telegram ...) and switches pressed on the wall (a change reported by a device without a
  command before). Scripts keep running anyway; their switching is played only on request. The
  commands of the simulation itself never count.
- **Time shift**: each group of switchings by up to ±15 minutes at random; afternoon and evening
  additionally by the difference of the sunsets (coordinates of the system settings).
- **What is switched**: lights (on/off, brightness) and blinds (position), optionally media on/off.
  Heating, locks, doors, gates, sockets, valves, alarms and read-only states are never switched,
  whatever the settings say.
- **Test**: "Only log, switch nothing" writes each planned switching to the log. The tab shows the
  plan for today (also before saving the settings), `sendTo('recorder.0', 'getSimulationPlan', {})`
  returns it as data.

`recorder.0.simulation.sourceDay`, `nextAction` and `lastAction` show what the simulation does. A
running simulation continues after a restart of the instance.

## Anomaly detection

For every recorded state the instance learns what is usual in each hour of the week and reports
what does not fit. The statistics are collected all the time (also with the detection switched off,
kept for a year); a profile is used after a learning period of 14 days. Enable and tune the rules in
the tab "Anomalies" of the instance settings.

On the first start the statistics of the existing recording (up to 8 weeks) are computed in the
background, so with 14 days of recording the rules work at once. Only "Silent sensor" and "Racing
datapoint" need the counted updates, which the recording does not contain: they start after 7 days.

| Rule                       | Reports                                                                                                                             | Default             |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------|---------------------|
| Unusual value              | a temperature, a power ... far from the usual value of this hour of the week (z-score) and outside of everything seen at this time  | z > 3 for 30 min    |
| Rare activity              | a door, a window, motion or a light in an hour in which this hardly ever happens (the front door at 3 am)                           | < 2 % of the weeks  |
| Silent sensor              | no update for 4 times the usual interval                                                                                            | at least 6 h        |
| Open or on unusually long  | windows, doors and lights, compared with the usual duration (95th percentile)                                                       | 1.5 times           |
| Window open in the cold    | a window or door open while it is cold outside                                                                                      | < 5 °C for 30 min   |
| Racing datapoint           | far more changes per hour than usual, or throttled by the burst limit (a defective sensor)                                          | 10 times            |

- **Absence**: while the absence state of the tab "Presence simulation" reports absence, every
  motion and every opening of a door or window is reported.
- **Outdoor temperature**: the configured state, otherwise a recorded current weather temperature.
- **Quiet time**: at most one report per state and rule within 12 hours. A condition (cold window,
  silent sensor ...) ends by itself when it no longer holds.
- **Output**: `recorder.0.anomaly.active`, `count`, `list` (JSON) and `last`; an ioBroker
  notification (shown in admin, forwarded by the adapter notification-manager) and optionally a
  message to an instance such as `telegram.0` or `pushover.0`. `recorder.0.anomaly.ack` acknowledges
  all open anomalies.
- **Messages**: `getAnomalies` (`{ start, end, open }`), `getProfile` (`{ id }`: the 168 hours of the
  week with mean, deviation, minimum, maximum and share of activity), `ackAnomaly` (`{ id }`, without
  `id`: all).

## For AI agents

`sendTo('recorder.0', 'help', {})` answers `{ help: '...' }`: a text for an AI agent (e.g. ioBroker.pi-agent, or
the MCP server with `send_to`) that describes all messages with their filters and answers, the states, and how to
answer the user (names and rooms instead of IDs, filters instead of the whole house, changes only on request).
An unknown message answers `{ error, commands }` with the list of all messages.

## How it differs from `history`, `sql` and `influxdb`

|                      | recorder                                                                                                                                                                                         | `history`, `sql`, `influxdb`                                                              |
|----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| Which states         | selected automatically by their meaning (type detector, enums, roles), plus rules and exceptions per state                                                                                       | only states with settings in `common.custom`, configured one by one                       |
| What is stored       | filtered by role (dead band, minimum interval, heartbeat); high-frequency numbers as 5 minute values (min, max, mean, last)                                                                      | configured per state (debounce, changes only ...)                                         |
| How long             | 1, 7, 30 or 90 days of raw data for all states; hourly statistics for a year                                                                                                                     | configured per state, also forever                                                        |
| Who switched         | every change with `from` and `user`, classified as user, script, adapter or system; used by journal, replay and simulation                                                                       | the source is not evaluated                                                               |
| All states at time T | one query, answered from hourly keyframes in milliseconds (`getSnapshot`)                                                                                                                        | one `getHistory` per state                                                                |
| Charts and scripts   | `getHistory` with the same options and aggregation (`@iobroker/aggregate`); echarts after 6.3.0 lists all recorded states, the admin object browser only states with an entry in `common.custom` | admin object browser, echarts, scripts                                                    |
| Writing              | read only: no `storeState`, no changing or deleting of values; `q` is not stored                                                                                                                 | `storeState`, changing and deleting values (depending on the adapter)                     |
| Database             | SQLite files in the data directory of the instance, one per week; no server                                                                                                                      | `history`: JSON files; `sql`: a database server or SQLite; `influxdb`: an InfluxDB server |
| On top               | time machine, presence simulation, anomaly detection                                                                                                                                             | -                                                                                         |

The recorder runs alongside them. Long-term archives in raw resolution remain the job of
`influxdb` and `sql`.

## Storage

SQLite in the data directory of the instance (`iobroker-data/recorder.0/`):

- `meta.sqlite`: master data of the recorded states, sources, statistics
- `ev-YYYY-Www.sqlite`: events and keyframes of one ISO week (UTC)

Changes are collected in memory and written in one transaction every 30 seconds (WAL mode), which
spares SD cards. The retention deletes whole week files daily at 03:30.

Requires Node.js 22.19 or newer (`node:sqlite`, no native module).

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

## Changelog
### **WORK IN PROGRESS**
* (bluefox) The script that changed a state is recorded (`state.c` of javascript and other automations): `c` in `getSnapshot` and `getEvents`, `comment: true` in `getHistory`; the journal and the tiles of the time machine name it
* (bluefox) Declared `common.supportedMessages.help`, so AI agents (e.g. ioBroker.pi-agent) know that the instance describes its messages
* (bluefox) `meta.sqlite` gets schema version 6 (sources with the script); after the update, version 0.1.x cannot open it any more

### 0.1.3 (2026-11-19)
* (bluefox) README: description of `getSnapshot`, `getEvents` and `getTimeline`; German documentation in `docs/de/README.md`
* (bluefox) Message `help`: describes all messages and states for an AI agent (e.g. ioBroker.pi-agent); an unknown message answers with the list of messages

### 0.1.2 (2026-11-17)
* (bluefox) Requires admin 7.6.17 or newer
* (bluefox) Published with npm trusted publishing (provenance)

### 0.1.1 (2026-11-17)
* (bluefox) README: comparison with `history`, `sql` and `influxdb` as a table

### 0.1.0 (2026-11-17)
* (bluefox) Initial version: storage layer, batched writing, keyframes, retention
* (bluefox) Automatic selection of the states: type detector, rooms/functions, roles, rules, per-state settings, preview in the admin
* (bluefox) 5 minute aggregation for high-frequency values (energy)
* (bluefox) `getHistory`, `features`, `getEnabledDPs`, `enableHistory`, `disableHistory` like `history`, `sql` and `influxdb`; `common.getHistory`, so that admin and echarts offer the instance
* (bluefox) Frequency filter (dead band, minimum interval, heartbeat, throttling) and classification of high-frequency states by their measured rate
* (bluefox) Walk into the past: `getSnapshot`, `getEvents`, `getTimeline`, replay with mirror states and the admin tab "Time machine"
* (bluefox) Presence simulation: replays the switching of lights and blinds of a recorded day at home, started by an absence state or by hand
* (bluefox) Anomaly detection: hourly statistics and weekly profiles, six rules (unusual value, rare activity, silent sensor, open too long, window open in the cold, racing datapoint), states and ioBroker notifications
* (bluefox) Anomaly detection learns from the existing recording; the profiles are rebuilt in small steps

## License
The MIT License (MIT)

Copyright (c) 2026 bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
