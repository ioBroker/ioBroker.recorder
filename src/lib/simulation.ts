/*
 * Presence simulation: which datapoints may be switched, which recorded events were actions of a
 * person, which day is played back and when its actions happen today. Pure functions; the timers
 * and the switching are in `simulator.ts`.
 *
 * A simulated day runs from noon to noon (local time): the evening, when lights go on, and the
 * night, when they go off again, come from the same recorded day. At noon, when nothing is lit
 * in an empty house anyway, the next recorded day takes over.
 */
import { SourceKind, type DpInfo, type RecordedEvent } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Local hour at which a simulated day starts */
export const WINDOW_START_HOUR = 12;
/** A day counts as a day at home with at least this many actions */
export const MIN_DAY_ACTIONS = 3;
/** A change that a device reports this long after a command is the answer to the command */
const COMMAND_ECHO = 2 * MINUTE;
/** Actions of one datapoint closer than this are one action with the last value (a dimmer slider) */
const MERGE_WINDOW = MINUTE;
/** Actions closer than this form a group (a scene, leaving a room) that is shifted as a whole */
const GROUP_GAP = 2 * MINUTE;
/** Two actions of one datapoint stay at least this far apart after the shift */
const MIN_SPACING = MINUTE;

/** Roles and device types that are never switched, whatever the category says */
const FORBIDDEN = /lock|door|gate|garage|valve|heat|thermostat|temperature|alarm|siren|socket|outlet|pump/i;

/** Who made an action */
export type ActionKind = 'user' | 'script' | 'device';

/** An action of a person in the recorded events */
export interface SimAction {
    ts: number;
    /** `dp.id` */
    dp: number;
    /** The value as stored: booleans are 0/1 */
    val: number;
    kind: ActionKind;
}

/** An action moved onto the simulated day */
export interface PlannedAction extends SimAction {
    /** When it happened on the recorded day */
    sourceTs: number;
}

export interface SimulationSettings {
    /** Recorded days: the same weekday 1 to `weeks` weeks back */
    weeks: number;
    /** Random shift of each group of actions, ± minutes */
    jitter: number;
    /** Shift afternoon and evening by the difference of the sunsets */
    sunset: boolean;
    /** Also switch media on and off */
    media: boolean;
    /** Also play the commands of scripts */
    scripts: boolean;
    latitude?: number;
    longitude?: number;
}

/**
 * May the simulation switch this datapoint? Lights (on/off and brightness), shading (position)
 * and, with `media`, media (on/off). Heating, locks, sockets, gates and anything read-only are
 * never switched, and there is no setting to change that.
 *
 * @param dp the recorded datapoint
 * @param common `common` of its object
 * @param media media may be switched
 */
export function isSimulatable(
    dp: Pick<DpInfo, 'category' | 'role' | 'type' | 'devType'>,
    common: Partial<ioBroker.StateCommon> | undefined,
    media: boolean,
): boolean {
    if (!common || common.write === false) {
        return false;
    }
    const role = dp.role || common.role || '';
    if (FORBIDDEN.test(role) || FORBIDDEN.test(dp.devType || '')) {
        return false;
    }
    switch (dp.category) {
        case 'light':
            return dp.type === 'boolean' || (dp.type === 'number' && /^level(\.dimmer|\.brightness)?$/.test(role));
        case 'shading':
            return dp.type === 'number' && /^level(\.blind|\.curtain|\.tilt)?$/.test(role);
        case 'media':
            return media && dp.type === 'boolean' && /^switch(\.power)?$/.test(role);
        default:
            return false;
    }
}

/**
 * Does the trigger state report absence? true, a number other than 0 and any text except
 * "", "0", "false", "off" and "no" are set; `invert` for a presence state (true: at home).
 *
 * @param val the value of the trigger state
 * @param invert the state reports presence
 */
export function triggerMeansAway(val: ioBroker.StateValue | undefined, invert: boolean): boolean {
    let set = false;
    if (typeof val === 'boolean') {
        set = val;
    } else if (typeof val === 'number') {
        set = val !== 0;
    } else if (typeof val === 'string') {
        set = !['', '0', 'false', 'off', 'no'].includes(val.trim().toLowerCase());
    }
    return set !== invert;
}

/** Is the value "on" (a light, a media player)? */
export function isOn(val: number | null): boolean {
    return val !== null && val > 0;
}

/**
 * The actions of a person in the events of some datapoints, sorted by time:
 * - commands from a user interface (vis, app, voice assistant ...), with `scripts` also of scripts,
 * - changes that a device reports without a command before: a switch pressed on the wall.
 *
 * The answer of a device to a command and the commands of other adapters (the simulation itself)
 * are no actions. Actions of one datapoint within a minute are one action with the last value.
 *
 * @param events the events, sorted by time
 * @param kindOf the kind of a source
 * @param before the value of each datapoint before the first event, to detect real changes
 * @param scripts the commands of scripts count
 */
export function collectActions(
    events: RecordedEvent[],
    kindOf: (src: number | null) => SourceKind | undefined,
    before: Map<number, number | null>,
    scripts: boolean,
): SimAction[] {
    const lastValue = new Map(before);
    const lastCommand = new Map<number, number>();
    const lastAction = new Map<number, SimAction>();
    const actions: SimAction[] = [];
    for (const event of events) {
        if (event.val === null) {
            continue;
        }
        const kind = kindOf(event.src);
        const previous = lastValue.get(event.dp);
        lastValue.set(event.dp, event.val);
        let actionKind: ActionKind | null = null;
        if (!event.ack) {
            lastCommand.set(event.dp, event.ts);
            if (kind === SourceKind.User) {
                actionKind = 'user';
            } else if (kind === SourceKind.Script && scripts) {
                actionKind = 'script';
            }
        } else if (previous !== undefined && previous !== event.val) {
            if (kind === SourceKind.User) {
                // set with ack in a user interface, e.g. in admin
                actionKind = 'user';
            } else if (kind === SourceKind.Adapter) {
                const command = lastCommand.get(event.dp);
                if (command === undefined || event.ts - command > COMMAND_ECHO) {
                    actionKind = 'device';
                }
            }
        }
        if (!actionKind) {
            continue;
        }
        const merged = lastAction.get(event.dp);
        if (merged && event.ts - merged.ts < MERGE_WINDOW) {
            merged.ts = event.ts;
            merged.val = event.val;
        } else {
            const action: SimAction = { ts: event.ts, dp: event.dp, val: event.val, kind: actionKind };
            actions.push(action);
            lastAction.set(event.dp, action);
        }
    }
    return actions.sort((a, b) => a.ts - b.ts);
}

/** The start of the simulated day that contains `ts`: the last local noon at or before it */
export function windowStart(ts: number): number {
    const date = new Date(ts);
    if (date.getHours() < WINDOW_START_HOUR) {
        date.setDate(date.getDate() - 1);
    }
    date.setHours(WINDOW_START_HOUR, 0, 0, 0);
    return date.getTime();
}

/** The start of the simulated day `days` days after the one starting at `start` (local noon) */
export function addWindows(start: number, days: number): number {
    const date = new Date(start);
    date.setDate(date.getDate() + days);
    date.setHours(WINDOW_START_HOUR, 0, 0, 0);
    return date.getTime();
}

/** Local days between the dates of two timestamps (DST safe) */
function dayOffset(ts: number, start: number): number {
    const a = new Date(ts);
    const b = new Date(start);
    a.setHours(0, 0, 0, 0);
    b.setHours(0, 0, 0, 0);
    return Math.round((a.getTime() - b.getTime()) / DAY);
}

/** The number of actions per simulated day (by its start) */
export function actionsPerWindow(actions: SimAction[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const action of actions) {
        const start = windowStart(action.ts);
        counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    return counts;
}

/**
 * The recorded day that is played on the simulated day starting at `target`: at random one of the
 * same weekdays 1 to `weeks` weeks back on which somebody was at home (at least
 * `MIN_DAY_ACTIONS` actions); if there is none, any earlier day at home.
 *
 * @param target start of the simulated day
 * @param counts actions per recorded day
 * @param weeks how many weeks back
 * @param random a random number in [0, 1)
 */
export function pickSourceDay(
    target: number,
    counts: Map<number, number>,
    weeks: number,
    random: () => number,
): { start: number; sameWeekday: boolean } | null {
    const atHome = (start: number): boolean => (counts.get(start) ?? 0) >= MIN_DAY_ACTIONS;
    const sameWeekday: number[] = [];
    for (let week = 1; week <= weeks; week++) {
        const start = addWindows(target, -7 * week);
        if (atHome(start)) {
            sameWeekday.push(start);
        }
    }
    const candidates = sameWeekday.length
        ? sameWeekday
        : [...counts.keys()].filter(start => start < target && atHome(start)).sort((a, b) => a - b);
    if (!candidates.length) {
        return null;
    }
    return {
        start: candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))],
        sameWeekday: sameWeekday.length > 0,
    };
}

/**
 * Moves the actions of the recorded day starting at `source` onto the simulated day starting at
 * `target`: the same local time of day; the afternoon and evening (until midnight) additionally by
 * `sunsetShift`; every group of actions (closer than 2 minutes, e.g. a scene) by one random offset
 * of ±`jitter` minutes. A datapoint keeps the order of its actions, and nothing leaves the day.
 *
 * @param actions the actions of the recorded day
 * @param source start of the recorded day
 * @param target start of the simulated day
 * @param options shifts
 * @param options.jitter ± minutes
 * @param options.sunsetShift ms, sunset of the simulated day minus sunset of the recorded day
 * @param random a random number in [0, 1)
 */
export function planDay(
    actions: SimAction[],
    source: number,
    target: number,
    options: { jitter: number; sunsetShift: number },
    random: () => number,
): PlannedAction[] {
    const sourceEnd = addWindows(source, 1);
    const targetEnd = addWindows(target, 1);
    const lastOf = new Map<number, number>();
    const planned: PlannedAction[] = [];
    let groupEnd = -Infinity;
    let offset = 0;
    for (const action of [...actions].sort((a, b) => a.ts - b.ts)) {
        if (action.ts < source || action.ts >= sourceEnd) {
            continue;
        }
        if (action.ts - groupEnd >= GROUP_GAP) {
            offset = Math.round((random() * 2 - 1) * options.jitter * MINUTE);
        }
        groupEnd = action.ts;

        const days = dayOffset(action.ts, source);
        const at = new Date(action.ts);
        const moved = new Date(target);
        moved.setDate(moved.getDate() + days);
        moved.setHours(at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds());
        let ts = moved.getTime() + offset;
        if (days === 0) {
            ts += options.sunsetShift;
        }
        const last = lastOf.get(action.dp);
        if (last !== undefined && ts < last + MIN_SPACING) {
            ts = last + MIN_SPACING;
        }
        ts = Math.min(Math.max(ts, target), targetEnd - 1);
        lastOf.set(action.dp, ts);
        planned.push({ ...action, ts, sourceTs: action.ts });
    }
    // stable: actions at the same time keep their order
    return planned.sort((a, b) => a.ts - b.ts);
}

// ---------------------------------------------------------------- sunset

const RAD = Math.PI / 180;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;

function toDays(ts: number): number {
    return ts / DAY - 0.5 + J1970 - J2000;
}

/**
 * The sunset of the local day of `ts`, by the formulas of suncalc (Vladimir Agafonkin, BSD-2):
 * accurate to a minute. `null` in polar day or night.
 *
 * @param ts any time of the day
 * @param latitude degrees north
 * @param longitude degrees east
 */
export function sunsetOf(ts: number, latitude: number, longitude: number): number | null {
    const noon = new Date(ts);
    noon.setHours(12, 0, 0, 0);
    const lw = RAD * -longitude;
    const phi = RAD * latitude;
    const n = Math.round(toDays(noon.getTime()) - J0 - lw / (2 * Math.PI));
    const ds = J0 + lw / (2 * Math.PI) + n;
    const m = RAD * (357.5291 + 0.98560028 * ds);
    const center = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
    const l = m + center + RAD * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
    const cosH = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosH < -1 || cosH > 1) {
        return null;
    }
    const w = Math.acos(cosH);
    const a = J0 + (w + lw) / (2 * Math.PI) + n;
    const julian = J2000 + a + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
    return Math.round((julian + 0.5 - J1970) * DAY);
}

/** Sunset of the simulated day minus sunset of the recorded day (0 without coordinates) */
export function sunsetShift(source: number, target: number, settings: SimulationSettings): number {
    if (!settings.sunset || settings.latitude === undefined || settings.longitude === undefined) {
        return 0;
    }
    const before = sunsetOf(source, settings.latitude, settings.longitude);
    const after = sunsetOf(target, settings.latitude, settings.longitude);
    if (before === null || after === null) {
        return 0;
    }
    // the time of day of the sunsets, not the days between them
    const days = dayOffset(target, source);
    const moved = new Date(before);
    moved.setDate(moved.getDate() + days);
    return after - moved.getTime();
}
