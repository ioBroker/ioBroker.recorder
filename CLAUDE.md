# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`iobroker.recorder` records all relevant states of an ioBroker installation for a limited period
(1 to 90 days) without per-state configuration, modelled on the recorder of Home Assistant. On top
of the recording it will offer three features: "walk into the past" (state of the house at any
time, replay), presence simulation and anomaly detection.

The implementation plan (German) is the Claude Doc "ioBroker.recorder: Umsetzungsplan"
(https://claude.ai/artifact/1gpUdWWmBnJrsDi7DwSGVu). It defines six milestones:

| Milestone | Content | Status |
| --- | --- | --- |
| M1 | scaffold, SQLite storage, batched writing, keyframes, retention | done |
| M2 | selection engine (type detector, enums, roles, include/exclude, custom exclusions) | done |
| M3 | frequency filter, classification by rate, 5 min aggregation, `getHistory` | done (7 day acceptance run and Echarts test open) |
| M4 | walk into the past: `getSnapshot`, `getEvents`, replay, admin tab (React) | done |
| M5 | presence simulation | done |
| M6 | anomaly detection | open |

TypeScript 6 (CommonJS output) according to `../REFACTORING.md`. Sources in `src/`, the runnable
code is the compiled `build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored.

## Commands

```bash
npm run build                             # backend (tsc -> build/) and the admin tab (tasks.ts)
npm run build-backend                     # tsc -p tsconfig.build.json  -> build/
npm run build-tab                         # tsx tasks.ts: src-tab (vite) -> admin/tab.html + admin/assets/
npm run check-tab                         # type check of src-tab
npm run lint-tab                          # eslint of src-tab (own config, reactConfig)
npm run check                             # type check only
npm run lint                              # eslint (@iobroker/eslint-config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:package                      # package.json / io-package.json / admin JSON
npm run test:unit                         # mocha test/unit - runs against build/, build first
npm run test:integration                  # real js-controller + adapter; aborts if a js-controller is running
npm run bench -- --rate 10000 --seconds 60 --dps 2000   # load test of the storage layer (build first)
npm run translate                         # admin/i18n from en.json
```

There is deliberately **no `prepare` script**; `common.nogit` is `true`. The settings are pure
JsonConfig; only the tab "Time machine" is React (`src-tab/`, own `package.json` and
`node_modules`). `tasks.ts` (tsx, `@iobroker/build-tools`) installs src-tab if needed, builds it with
vite and copies `src-tab/build/*` into `admin/`. `admin/tab.html` and `admin/assets/` are
gitignored, so `npm run build` must run before `npm pack`.

## Architecture

| Path | Content |
| --- | --- |
| `src/main.ts` | `RecorderAdapter`: object cache, selection runs, subscriptions, value cache, buffer, timers, `onMessage` |
| `src/lib/selection.ts` | `computeSelection()` (pure, the four levels) and `DeviceDetection` (cached type detector) |
| `src/lib/categories.ts` | the 10 categories: detector types, recorded state names, fallback roles, negative roles |
| `src/lib/aggregator.ts` | 5 minute aggregates (min, max, mean of samples, last) for class "aggregated" |
| `src/lib/preview.ts` | size estimate and the HTML table of the admin tab "Preview" |
| `src/lib/filter.ts` | frequency filter: `filterRuleFor` (defaults per role, role rules), `ChangeFilter`, `RateMeter`, `nextRate` |
| `src/lib/walk.ts` | walk into the past: `readSnapshot`, `readChanges` (replay), `readEventList` (journal), `readTimeline` |
| `src/lib/walk-types.ts` | request and answer types of `getSnapshot` / `getEvents` / `getTimeline`, also imported by the tab |
| `src/lib/simulation.ts` | presence simulation, pure: `isSimulatable`, `collectActions`, noon-to-noon days, `pickSourceDay`, `planDay`, `sunsetOf` |
| `src/lib/simulator.ts` | `PresenceSimulation` (timers, switching, stop) behind `SimulationHost`, `planSimulatedDay`, `renderPlan` |
| `src-tab/` | admin tab "Time machine" (React 19, MUI, gui-components, vite): `TimeMachine`, `Timeline`, `RoomTiles`, `Journal` |
| `tasks.ts` | build of the tab into `admin/` |
| `src/lib/history.ts` | `getHistory`: options parsed like sql (`parseHistoryRequest`), reading with border values (`readHistory`) |
| `src/lib/storage.ts` | `Storage`: meta.sqlite + one file per week, upsert of datapoints, sources, batch write, retention |
| `src/lib/schema.ts` | SQL schemas, versioned with `PRAGMA user_version` |
| `src/lib/sqlite.ts` | driver abstraction over `node:sqlite` (suppresses its ExperimentalWarning) |
| `src/lib/week.ts` | ISO weeks in UTC, week file names |
| `src/lib/values.ts` | encoding of state values into `val` (REAL) / `sval` (TEXT) |
| `src/lib/source.ts` | classification of `state.from` into user / script / adapter / system |
| `src/lib/types.ts` | shared types and enums |
| `src/lib/adapter-config.d.ts` | `ioBroker.AdapterConfig`, keep in sync with `native` and `admin/jsonConfig.json` |

### Storage

- Data directory: `utils.getAbsoluteInstanceDataDir(this)` = `iobroker-data/recorder.0/`.
- `meta.sqlite`: tables `dp` (master data; `dp.id` is the key used everywhere), `src` (deduplicated
  `from`/`user`), `rate` (measured changes per minute, high-frequency flag; schema v2), `stat_hour`,
  `profile` (both for M6). Schema changes are migrations in `schema.ts` (`META_MIGRATIONS`), one per
  version in `PRAGMA user_version`.
- `ev-YYYY-Www.sqlite`: `ev` (events), `keyframe`, `agg5` (M3). Weeks are **UTC** (Monday 00:00 UTC),
  so the file of a timestamp does not depend on time zone or DST.
- `dp.type` (boolean/number/string/json) is an addition to the schema of the plan: it is needed to
  decode `val` back into a boolean.
- All files: WAL, `synchronous = NORMAL`, `wal_autocheckpoint = 256`, `journal_size_limit = 1 MB`
  (otherwise the WAL stays at 4 MB per open file and distorts `info.dbSize`). All calls are
  synchronous (node:sqlite), so `onUnload` can flush before calling the callback.
- Master data changes for a whole selection run in one transaction (`Storage.batchMeta`).

### Selection

`computeSelection()` evaluates four levels; a later one overrides an earlier one:

1. **Type detector** (`@iobroker/type-detector`): every channel, every device with direct states and
   every stand-alone state with a meaningful role is examined. Only the state names listed per
   category in `categories.ts` are taken (no indicators, battery, RSSI, buttons). `ELECTRIC_POWER`
   and `CONSUMPTION` of any device go to the category "energy".
2. **Enums**: with `requireEnum` only states that are in a room or function themselves or by their
   channel or device. Room and function names are always stored in `dp.room` / `dp.func`.
3. **Roles**: fallback roles per category for states without a detected device; the negative roles
   (`info.*`, `indicator.connected/reachable`, `button*`, `text`, `json`, `url`) drop any candidate.
   Then the category modes (`catLight` ... `catEnergy`: off / on / aggregated) apply.
4. **Manual**: include patterns, exclude patterns (wins over include), then
   `common.custom[recorder.0]` with `mode: 'always' | 'exclude' | 'auto'` (wins over everything;
   `auto` leaves the selection alone and only sets `filter`). The plan said `enabled = false`, but
   the admin deletes the custom settings when they are disabled.

`dp.name` is `displayName()`: the own name, but if it is only the last part of the ID ("SET",
"ACTUAL", "temperatureC"), the name of the channel or device goes in front ("Licht SET",
"Waschmaschine temperatureC"); a parent name that only contains its own ID part ("Channel Relay0")
is skipped. Room and function names are deduplicated (two enums with the same name).

`system.*` and the own namespace are never selected automatically. An alias and its target carry
the same values: the alias is kept, the target dropped (unless included manually).

The type detector is the expensive part (~1 s for 40,000 states on a desktop CPU). `DeviceDetection`
keeps its results per examined object; `onObjectChange` invalidates the object, its channel, its
device and, for channels/devices, their direct children. The first full run yields to the event
loop every 200 detections. **The detector caches results per instance: always use a new
`ChannelDetector` per run.** Object changes are collected for 30 s (`RESELECT_DELAY`).

### Messages (`sendTo`)

| Command | Message | Answer |
| --- | --- | --- |
| `getSelection` | - | `[{ id, name, room, func, category, devType, cls, reason }]` |
| `previewSelection` | (unsaved) native config | `{ text: html, count, mbPerMonth }` for `textSendTo` with `container: html` |
| `recalculate` | - | `{ result }` after a selection run |
| `getHistory` | `{ id, options }` as for history/sql/influxdb | `{ result, step, sessionId }` via `sendResponse` |
| `features` | - | `{ supportedFeatures: [] }` (no update/delete/storeState) |
| `getEnabledDPs` | - | `{ [id]: { enabled, category, cls, reason } }` of the recorded states |
| `enableHistory` / `disableHistory` | `{ id, options? }` | sets `common.custom[recorder.0].mode` to `always` / `exclude` |
| `getHighFrequency` | - | `{ text: html }` for the admin tab "High frequency" |
| `getSnapshot` | `{ ts?, room?, category?, ids? }` | `{ ts, keyframe, states: [{ id, name, room, category, val, text, lc, from, user, src }], ms }` |
| `getEvents` | `{ start?, end?, room?, category?, ids?, src?, limit?, newest? }` | `{ events: [{ ts, id, name, room, val, text, ack, from, user, src }], more, ms }` |
| `getTimeline` | `{ start?, end?, buckets?, room?, category?, ids?, src? }` | `{ start, end, step, counts, first, ms }` |
| `getSimulationPlan` | (unsaved) `simWeeks`, `simJitter`, `simSunset`, `simMedia`, `simScripts` | `{ text: html, start, source, actions: [{ ts, sourceTs, id, name, room, val, kind }] }` |

`getHistory` follows history, sql and influxdb and uses `@iobroker/aggregate` (`sendResponse`) for
the aggregation, so all methods (`none`, `onchange`, `minmax`, `average`, `total`, `percentile`,
`integral`, `intervalBorders` ...) behave the same. Specifics:

- The value before `start` is the last event or, if later, the hourly keyframe: a value that did
  not change for weeks is found in the week file of `start`. The value after `end` is the next event.
  If nothing is known before `start` (the recording started within the range), the first keyframe
  in the range before the first change counts: it holds the values at the start of the recording.
- The buffer and the running 5 minute intervals are included (nothing waits for the flush).
- Class "aggregated" has no single values: each 5 minute interval gives one entry in its middle
  (`min`/`max` for those methods, both for `minmax`, the mean otherwise). Intervals exist only
  where samples came in, so the value before `start` is the keyframe if it is newer than the last
  interval: a value that seldom changes (a forecast) would otherwise give an empty answer.
- Strings and JSON fall back from a numeric method to `onchange`; booleans are 0/1 for the
  aggregation and `true`/`false` for `none`/`onchange`.
- `from: true` also returns `user`; `q` is not stored.
- A request for the target of a recorded alias is answered from the alias.

`common.getHistory: true` in `io-package.json` is required: admin (chart in the object dialog,
"default history" in the system settings) and the echarts editor list only instances with this
flag. Admin lists only states with an entry in `common.custom[recorder.0]`, so automatically
selected states are not shown there (charts that name `recorder.0` explicitly work). The echarts
editor asks every running history instance for `getEnabledDPs` (echarts newer than 6.3.0) and shows
them all; `{ enabled: true }` without `mode` written by its "add state" dialog means "always".

### Walk into the past

- **Snapshot at T**: the newest keyframe at or before T (week files newest first), then the events in
  (keyframe, T] on top, then for class "aggregated" the `last` of the newest 5 minute interval that
  ended in (keyframe, T]. The buffer and the running intervals count as well. `lc` is the time of the
  event, `null` for a value from the keyframe. Measured: 15 ms median, 29 ms max for 1,000 datapoints
  with 10,000 changes after the keyframe (target < 100 ms).
- **Filters**: `room` / `category` / `ids` select datapoints (`dp.room` may hold several rooms
  separated by commas), `src` (`user` / `script` / `adapter` / `system`) selects sources. Lists are
  inlined into the SQL as integers.
- **Replay** (`replay.active` / `replay.time` / `replay.speed`, only commands with `ack: false`): a jump
  writes the snapshot into the mirrors; playing advances `speed` seconds per real second and writes
  only the changes (`readChanges`); it stops at the present. The mirrors
  `mirror.<oid, . and forbidden chars as _>` exist only with `mirrorStates`; `syncMirrors` creates
  and deletes them after every selection run.
- **Tab**: one snapshot per jump (debounced to 150 ms while dragging, stale answers are dropped), the
  journal of 6 h before the cursor, playback fetches only the changes since the last step and loads
  a full snapshot every 20 steps (5 minute values) or when there were too many changes. The status
  line shows the time of a jump until the commit (`useLayoutEffect`, not the next frame: browsers
  throttle frames of background windows). Measured on vitanova (1,202 states, 233 kB snapshot):
  86-165 ms, of which ~100 ms are the round trip through admin.
- **Rendering**: the tiles and the journal are plain elements with class names and one `sx` per
  list (`GRID_SX`, `LIST_SX`), `title` instead of MUI tooltips, `React.memo` for tiles and journal
  (a tile renders again only if its room or its highlighted IDs change). Formatters and the collator
  are cached `Intl` objects in `format.ts`: `toLocaleString` / `localeCompare` per row cost
  ~200 ms per render. Keep it that way when adding rows.

### Presence simulation

- **Switchable** (`isSimulatable`, checked again before every switching): `common.write !== false`;
  never if role or device type match lock, door, gate, garage, valve, heat, thermostat, temperature,
  alarm, siren, socket, outlet or pump. Light: boolean or `level` / `level.dimmer` /
  `level.brightness`; shading: number with `level` / `level.blind` / `level.curtain` / `level.tilt`;
  media (only with `simMedia`): boolean `switch` / `switch.power`. No setting widens this.
- **Actions** (`collectActions`): commands (`ack: false`) of kind user, of kind script only with
  `simScripts`; changes with `ack: true` of kind user or of kind adapter without a command on that
  datapoint within 2 minutes (a switch on the wall). Commands of other adapters, the simulation
  itself included (`from` = this instance, kind adapter), are no actions, and their echoes neither.
  Actions of one datapoint within 1 minute are merged (last value).
- **Days** run from local noon to noon. A day counts as at home with at least 3 actions. Source: at
  random one of the same weekdays 1..`simWeeks` back at home, else any earlier day at home.
- **Plan** (`planDay`): same local time of day, the first calendar day (afternoon, evening) also by
  sunset(target) - sunset(source), one random offset of ±`simJitter` per group (gap < 2 min), a
  datapoint keeps its order (1 min apart), clamped into the day. Sunset by the suncalc formulas,
  coordinates from `system.config`.
- **Runtime**: `start` plans the current day from now on (no catching up); one timer to the next
  action, at most 1 h; an action more than 5 min overdue (suspended system) is skipped; an action is
  skipped if the state has that value already. At noon the next day is planned and the lights it
  switched on are switched off if they were off at the start of the new source day. `stop` clears
  the timer synchronously first, then switches off the lights and media it switched on.
  Commands are `ack: false` with `c: 'presence simulation'`.
- **Trigger**: `simTrigger` (subscribed, also kept subscribed when the selection drops it); away =
  truthy XOR `simTriggerInvert`; only changes count. `simulation.enabled` (`ack: false`) switches by
  hand. Unload only clears the timer: after a restart it resumes (without trigger: if
  `simulation.enabled` was true; with trigger: if the trigger says away) and takes the lights it
  switched on from the recording (last command within 2 days from this instance). If it ran but
  the trigger now says home, or the simulation is disabled in the settings, those lights are
  switched off (`finishAfterRestart`).
- `simDryRun` only logs. The plan of the plan preview is the running plan if the settings are the
  same, otherwise a new one (random choices differ).

### Recording path

1. `onStateChange` encodes the value and compares it with the value cache (the latest value, also
   if it was not stored). Timestamp-only updates are dropped. Value changes are counted for the
   rate. Numbers of class "aggregated" go to the `Aggregator` instead (every sample, also
   unchanged ones); finished intervals are written with the next flush into `agg5`, running ones
   on unload. Class "discarded" is only counted.
2. The `ChangeFilter` decides: "discrete" stores every change of value or ack; "continuous"
   applies the rule of the role (dead band absolute or in %, minimum interval with the latest value
   stored when it is over, heartbeat for changes within the dead band; ack-only changes are not
   stored). Every datapoint is throttled to `burstLimit` stored changes per minute, unless its
   custom `filter` is `all`. Held changes are stored by `due()` with every flush, all of them on
   unload (`takeHeld`). The base of the dead band after a start is the initial value.
3. Every full hour `RateMeter` gives the changes per minute (`nextRate`: high above `highRate`,
   normal again below half of it). The rates go to the table `rate`; if a classification
   changes, the selection runs again: high-frequency numbers become "aggregated", other states
   above `burstLimit` per minute "discarded". The custom `filter` (`all`, `aggregate`) overrides.
4. Events go into `buffer`; the flush timer (`flushInterval`, default 30 s) writes them in one
   transaction per week file. A buffer of `MAX_BATCH` events is written immediately.
5. If writing fails, the events stay in the buffer (at most `MAX_BUFFER`, older ones are dropped
   with an error in the log).
6. Keyframes from the value cache at start and at every full hour, written together with the buffer.
7. Retention at start and daily at 03:30 local time: deletes week files completely before the cutoff
   and trims the oldest remaining file to the exact cutoff.

The own namespace is never recorded (the info states change with every write).

## Conventions

- Timers only via `this.setTimeout` / `this.setInterval`.
- No `any`; foreign data as interfaces in `src/lib/types.ts`.
- Unit tests are plain JS with `node:assert` in `test/unit/*.test.js` against `build/`.
