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

> **Status:** early development. All six milestones of the plan are implemented; the long-term
> tests on real installations are still running.

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
### 0.1.2 (2026-11-17)
* (bluefox) Requires admin 7.6.17 or newer
* (bluefox) Published with npm trusted publishing (provenance)

### 0.1.1 (2026-11-17)
* (bluefox) README: comparison with history, sql and influxdb as a table

### 0.1.0 (2026-11-17)
* (bluefox) Initial version: storage layer, batched writing, keyframes, retention
* (bluefox) Automatic selection of the states: type detector, rooms/functions, roles, rules, per-state settings, preview in the admin
* (bluefox) 5 minute aggregation for high-frequency values (energy)
* (bluefox) `getHistory`, `features`, `getEnabledDPs`, `enableHistory`, `disableHistory` like history, sql and influxdb; `common.getHistory`, so that admin and echarts offer the instance
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
