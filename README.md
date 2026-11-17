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

> **Status:** early development (milestone 1: storage). Only states matched by the include patterns
> are recorded so far; the automatic selection follows.

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
