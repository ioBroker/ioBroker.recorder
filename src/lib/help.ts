/**
 * The answer of `help`: what the instance answers, written for an AI agent (e.g. ioBroker.pi-agent, or
 * the MCP server with `send_to`). Keep it in sync with `onMessage` in main.ts and the README.
 */
import { CATEGORIES } from './categories';

/** The commands `onMessage` answers */
export const COMMANDS = [
    'help',
    'getSnapshot',
    'getEvents',
    'getTimeline',
    'getHistory',
    'getSelection',
    'getAnomalies',
    'getProfile',
    'ackAnomaly',
    'getSimulationPlan',
    'enableHistory',
    'disableHistory',
    'getEnabledDPs',
    'features',
    'recalculate',
    'previewSelection',
    'getHighFrequency',
    'getAnomalyInfo',
];

export const HELP = `ioBroker.recorder: records the relevant states of the house by itself (no setting per state) for 1 to 90
days, every change with who made it. It answers what the house looked like at any moment, what changed and who
did it, and what is unusual (anomaly detection); it plays a recorded day while nobody is at home (presence
simulation).

Times (ts, start, end): milliseconds since 1970, or a text such as "2026-11-16T20:00" = local time of the ioBroker
host. Times in the answers are milliseconds since 1970.
Filters of getSnapshot, getEvents and getTimeline, each one value or a list (values OR, filters AND):
- room: the name of a room as in the answers (language of the system, case-insensitive), e.g. "Bad"
- category: ${CATEGORIES.map(c => c.key).join(', ')}
- ids: object IDs
- src (getEvents, getTimeline): user (admin, vis, apps, voice assistants, chat), script, adapter (the devices),
  system. A switch pressed on the wall is src adapter with ack true (no command before it), not user.

Commands (sendTo recorder.0):
- getSnapshot {ts?, room?, category?, ids?}: the value of every recorded state at ts (default now):
  {ts, keyframe, states: [{id, name, room, category, unit, val, text?, lc, from?, user?, src?}]}.
  text = the meaning of the value (e.g. "open"). lc = time of the last change only if it was within about the
  hour before ts, else null (null does not mean "never changed"). keyframe null: nothing recorded before ts.
- getEvents {start?, end?, room?, category?, ids?, src?, limit?, newest?}: the changes in [start, end] (default
  the last hour), oldest first: {events: [{ts, id, name, room, val, text?, ack, from, user?, src}], more}.
  ack false = a command, ack true = confirmation or measurement of the device (a command from a vis gives two
  entries). limit default 1000, at most 10000; more = there were more; newest = the newest ones instead of the
  oldest. High-frequency values (power, energy) are not listed: use getHistory.
- getTimeline {start?, end?, buckets?, room?, category?, ids?, src?}: number of changes per interval (default
  the last 24 h in 100 buckets): {start, step, counts, first}; first = since when anything is recorded.
- getHistory {id, options: {start?, end?, aggregate?, step?, count?, from?}}: the course of one state as with
  history, sql and influxdb: {result: [{ts, val}]}. aggregate none or onchange = the stored values; average
  (the default), min, max, minmax, total, percentile, integral = one value per step.
- getSelection: every recorded state: [{id, name, room, func, category, cls, reason}]; the room names to filter
  by, reason = why it is recorded.
- getAnomalies {start?, end?, open?, limit?}: the anomalies (default the last 7 days; open: only the open ones):
  {anomalies: [{id, ts, endTs, ackTs, rule, oid, name, room, val, text}]}; text explains it. rule: value
  (unusual value), rare (rare activity; also every motion or opening while away), silent (the sensor sends
  nothing), long (open or on unusually long), cold (window open in the cold), racing (far too many changes).
- getProfile {id}: what is usual for a state in each hour of the week (how 0 = Monday 0:00 local time):
  {learned, profile: [{how, n, mean, sd, min, max, pActive (share of the time active), avgChanges}]}.
- ackAnomaly {id?}: acknowledges one anomaly, without id all of them: {count}.
- getSimulationPlan {}: today's plan of the presence simulation: {source (the recorded day), actions: [{ts, id,
  name, room, val}]}.
- enableHistory {id} / disableHistory {id}: always record / never record a state (the selection follows
  within 30 s).
- getEnabledDPs, features, recalculate: for charts and the settings. previewSelection, getHighFrequency,
  getAnomalyInfo: HTML for the settings, not for agents.

States (recorder.0.*): simulation.enabled (true / false starts and stops the presence simulation, which
switches real lights and blinds; it must be enabled in the settings), simulation.sourceDay / nextAction /
lastAction, anomaly.active / count / list / last, anomaly.ack (acknowledges all), replay.time / speed / active
(plays the past into the states recorder.0.mirror.*).

How to talk to the user:
- Name states by name and room, not by ID; give a value by its text if it has one, else with its unit; times
  in local time.
- Use the filters: a snapshot of the whole house is large. If a room gives nothing, take its name from
  getSelection.
- "Who did it": from (e.g. system.adapter.vis-2.0), user (e.g. system.user.admin) and src.
- Only the states the recorder selected are recorded, and only for the retention (first of getTimeline). For a
  missing state say so; enableHistory records it from now on, if the user wants that.
- ackAnomaly, enableHistory, disableHistory and simulation.enabled change something: only on the user's
  request.`;
