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

The model is the recorder of Home Assistant.

> **Status:** early development (milestone 4 of 6: walk into the past). Presence simulation and
> anomaly detection follow.

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

| Role | Dead band | Min. interval | Heartbeat |
| --- | --- | --- | --- |
| `value.temperature`, `level.temperature` | 0.2 | 60 s | 1 h |
| `value.humidity` | 2 | 60 s | 1 h |
| `value.brightness` | 10 % | 60 s | 1 h |
| `level.dimmer`, `level.blind` | 1 | 0 s | none |
| `value.power` | 5 % | 60 s | 15 min |
| other numbers | 1 % | 60 s | 1 h |

The tab "Rules" overrides these values per role. A state that suddenly changes more than 60 times
per minute (a defective sensor) is throttled and reported in the log. The tab "High frequency"
lists the measured rates. Per state, "Filter" in the object browser can force "every change" or
"aggregate".

## Reading the data

`getHistory` works like with history, sql and influxdb (same options, same aggregation by
`@iobroker/aggregate`), so charts and scripts can use the recorder as a source:

```js
sendTo('recorder.0', 'getHistory', {
    id: 'hm-rpc.0.ABC.1.LEVEL',
    options: { start: Date.now() - 86400000, aggregate: 'none', from: true },
}, result => console.log(result.result));
```

Datapoints that are aggregated to 5 minutes (energy) return one value per interval.
`enableHistory` / `disableHistory` set "always record" / "never record" for a state.

## Walk into the past

The admin tab **Time machine** shows the state of every room at any moment of the recorded period:

- a timeline with the density of the changes; drag it, click it or use the arrow keys
- play / pause with 1x, 10x, 60x, 600x or 3600x speed
- tiles per room with lights, windows, climate, blinds ... and the journal of the changes before the
  cursor ("07:12 Bath · Light **on** (admin)")
- filters for room, category and "manual actions only"

The same data is available for scripts, vis and the MCP server:

```js
// the state of all recorded datapoints yesterday at 20:00 (room/category/ids filter optional)
sendTo('recorder.0', 'getSnapshot', { ts: '2026-11-16T20:00', room: 'Living room' }, answer =>
    console.log(answer.states)); // [{ id, name, room, category, val, text, lc, from, src }]

// what was switched by hand in the last 24 hours, with names and rooms
sendTo('recorder.0', 'getEvents', { start: Date.now() - 86400000, src: 'user' }, answer =>
    console.log(answer.events)); // [{ ts, id, name, room, val, text, from, user, src }]

// changes per interval, for a density chart
sendTo('recorder.0', 'getTimeline', { start: Date.now() - 86400000, buckets: 96 }, answer =>
    console.log(answer.counts));
```

**Replay into states:** `recorder.0.replay.time` (writable: jump), `recorder.0.replay.speed` and
`recorder.0.replay.active` play the past in the instance itself. With "Mirror states for the replay"
enabled, every recorded state gets a read-only copy `recorder.0.mirror.<id with _>` that shows the
replayed value, so a vis project can show the past without touching the real devices.

## How it differs from history, sql and influxdb

- The states are selected automatically by their meaning (type detector, enums, roles) instead of
  `common.custom` per state.
- Every change is stored together with its source (`from`, `user`), so replay and simulation know
  who switched something.
- Hourly keyframes answer "the state of all datapoints at time T" in milliseconds.
- Raw data is kept for a limited time only; hourly statistics remain for long-term profiles.

Long-term archives in raw resolution remain the job of influxdb and sql.

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
* (bluefox) Initial version: storage layer, batched writing, keyframes, retention
* (bluefox) Automatic selection of the states: type detector, rooms/functions, roles, rules, per-state settings, preview in the admin
* (bluefox) 5 minute aggregation for high-frequency values (energy)
* (bluefox) `getHistory`, `features`, `getEnabledDPs`, `enableHistory`, `disableHistory` like history, sql and influxdb
* (bluefox) Frequency filter (dead band, minimum interval, heartbeat, throttling) and classification of high-frequency states by their measured rate
* (bluefox) Walk into the past: `getSnapshot`, `getEvents`, `getTimeline`, replay with mirror states and the admin tab "Time machine"

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
