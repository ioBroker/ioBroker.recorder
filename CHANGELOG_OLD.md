# Older changes
## 0.1.0 (2026-11-17)
* (bluefox) Initial version: storage layer, batched writing, keyframes, retention
* (bluefox) Automatic selection of the states: type detector, rooms/functions, roles, rules, per-state settings, preview in the admin
* (bluefox) 5 minute aggregation for high-frequency values (energy)
* (bluefox) `getHistory`, `features`, `getEnabledDPs`, `enableHistory`, `disableHistory` like `history`, `sql` and `influxdb`; `common.getHistory`, so that admin and echarts offer the instance
* (bluefox) Frequency filter (dead band, minimum interval, heartbeat, throttling) and classification of high-frequency states by their measured rate
* (bluefox) Walk into the past: `getSnapshot`, `getEvents`, `getTimeline`, replay with mirror states and the admin tab "Time machine"
* (bluefox) Presence simulation: replays the switching of lights and blinds of a recorded day at home, started by an absence state or by hand
* (bluefox) Anomaly detection: hourly statistics and weekly profiles, six rules (unusual value, rare activity, silent sensor, open too long, window open in the cold, racing datapoint), states and ioBroker notifications
* (bluefox) Anomaly detection learns from the existing recording; the profiles are rebuilt in small steps
