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
| M2 | selection engine (type detector, enums, roles, include/exclude, custom exclusions) | open |
| M3 | frequency filter (dead band, min interval, heartbeat, aggregation), `getHistory` | open |
| M4 | walk into the past: `getSnapshot`, `getEvents`, replay, admin tab (React) | open |
| M5 | presence simulation | open |
| M6 | anomaly detection | open |

TypeScript 6 (CommonJS output) according to `../REFACTORING.md`. Sources in `src/`, the runnable
code is the compiled `build/` (`package.json` `main` is `build/main.js`). `build/` is gitignored.

## Commands

```bash
npm run build                             # tsc -p tsconfig.build.json  -> build/
npm run check                             # type check only
npm run lint                              # eslint (@iobroker/eslint-config)
npx eslint -c eslint.config.mjs --fix src # autofix + prettier formatting

npm run test:package                      # package.json / io-package.json / admin JSON
npm run test:unit                         # mocha test/unit - runs against build/, build first
npm run test:integration                  # real js-controller + adapter; aborts if a js-controller is running
npm run bench -- --rate 10000 --seconds 60 --dps 2000   # load test of the storage layer (build first)
npm run translate                         # admin/i18n from en.json
```

There is deliberately **no `prepare` script**; `common.nogit` is `true`. There is no `tasks.ts`
yet because the admin is pure JsonConfig; it is added with the React admin tab in M4.

## Architecture

| Path | Content |
| --- | --- |
| `src/main.ts` | `RecorderAdapter`: selection, subscriptions, value cache, buffer, timers |
| `src/lib/storage.ts` | `Storage`: meta.sqlite + one file per week, upsert of datapoints, sources, batch write, retention |
| `src/lib/schema.ts` | SQL schemas, versioned with `PRAGMA user_version` |
| `src/lib/sqlite.ts` | driver abstraction over `node:sqlite` (suppresses its ExperimentalWarning) |
| `src/lib/week.ts` | ISO weeks in UTC, week file names |
| `src/lib/values.ts` | encoding of state values into `val` (REAL) / `sval` (TEXT) |
| `src/lib/selection.ts` | which states are recorded; master data from the object |
| `src/lib/source.ts` | classification of `state.from` into user / script / adapter / system |
| `src/lib/types.ts` | shared types and enums |
| `src/lib/adapter-config.d.ts` | `ioBroker.AdapterConfig`, keep in sync with `native` and `admin/jsonConfig.json` |

### Storage

- Data directory: `utils.getAbsoluteInstanceDataDir(this)` = `iobroker-data/recorder.0/`.
- `meta.sqlite`: tables `dp` (master data; `dp.id` is the key used everywhere), `src` (deduplicated
  `from`/`user`), `stat_hour`, `profile` (both for M6).
- `ev-YYYY-Www.sqlite`: `ev` (events), `keyframe`, `agg5` (M3). Weeks are **UTC** (Monday 00:00 UTC),
  so the file of a timestamp does not depend on time zone or DST.
- `dp.type` (boolean/number/string/json) is an addition to the schema of the plan: it is needed to
  decode `val` back into a boolean.
- All files: WAL, `synchronous = NORMAL`, `wal_autocheckpoint = 256`, `journal_size_limit = 1 MB`
  (otherwise the WAL stays at 4 MB per open file and distorts `info.dbSize`). All calls are
  synchronous (node:sqlite), so `onUnload` can flush before calling the callback.
- Master data changes for a whole selection run in one transaction (`Storage.batchMeta`).

### Recording path

1. `onStateChange` encodes the value and compares it with the value cache. Only real changes of
   value **or ack** are recorded; timestamp-only updates are dropped.
2. Events go into `buffer`; the flush timer (`flushInterval`, default 30 s) writes them in one
   transaction per week file. A buffer of `MAX_BATCH` events is written immediately.
3. If writing fails, the events stay in the buffer (at most `MAX_BUFFER`, older ones are dropped
   with an error in the log).
4. Keyframes from the value cache at start and at every full hour, written together with the buffer.
5. Retention at start and daily at 03:30 local time: deletes week files completely before the cutoff
   and trims the oldest remaining file to the exact cutoff.

The own namespace is never recorded (the info states change with every write).

## Conventions

- Timers only via `this.setTimeout` / `this.setInterval`.
- No `any`; foreign data as interfaces in `src/lib/types.ts`.
- Unit tests are plain JS with `node:assert` in `test/unit/*.test.js` against `build/`.
