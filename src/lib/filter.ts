import { patternToRegExp } from './patterns';
import type { RateInfo, RecordedEvent } from './types';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** When a value of class "continuous" is stored */
export interface FilterRule {
    /** Smallest change that is stored; 0: every change */
    deadband: number;
    /** `deadband` in % of the last stored value instead of absolute */
    relative: boolean;
    /** ms: a change is stored at the earliest this long after the last stored value (the latest one then) */
    minInterval: number;
    /** ms: a change within the dead band is stored after this time; 0: never */
    heartbeat: number;
}

/** How a recorded datapoint is filtered */
export interface DpFilter {
    /** `null`: every change is stored (class "discrete") */
    rule: FilterRule | null;
    /** Throttle the datapoint if it changes more often than the burst limit */
    burst: boolean;
}

/** A role rule of the instance settings (`native.roleRules`): times in seconds and minutes */
export interface RoleRuleConfig {
    role: string;
    deadband?: number | string;
    relative?: boolean;
    /** seconds */
    minInterval?: number | string;
    /** minutes; 0: off */
    heartbeat?: number | string;
}

/** A role rule ready for matching */
export interface RoleRule {
    pattern: RegExp;
    rule: FilterRule;
}

/** Defaults of the plan, the first matching entry wins; `level.x` also matches `level.x.y` */
export const DEFAULT_RULES: { roles: string[]; rule: FilterRule }[] = [
    {
        roles: ['value.temperature', 'level.temperature'],
        rule: { deadband: 0.2, relative: false, minInterval: MINUTE, heartbeat: HOUR },
    },
    { roles: ['value.humidity'], rule: { deadband: 2, relative: false, minInterval: MINUTE, heartbeat: HOUR } },
    { roles: ['value.brightness'], rule: { deadband: 10, relative: true, minInterval: MINUTE, heartbeat: HOUR } },
    // user actions: no delay
    {
        roles: ['level.dimmer', 'level.blind', 'level.curtain', 'level.tilt'],
        rule: { deadband: 1, relative: false, minInterval: 0, heartbeat: 0 },
    },
    { roles: ['level'], rule: { deadband: 0, relative: false, minInterval: 0, heartbeat: 0 } },
    { roles: ['value.power'], rule: { deadband: 5, relative: true, minInterval: MINUTE, heartbeat: 15 * MINUTE } },
];

/** All other numbers */
export const OTHER_NUMBERS: FilterRule = { deadband: 1, relative: true, minInterval: MINUTE, heartbeat: HOUR };

function toNumber(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Converts the role rules of the instance settings; rules without a role are ignored. An object
 * with the indexes as keys is accepted as well: a deep merge of the settings turns arrays into it.
 *
 * @param config `native.roleRules`
 */
export function parseRoleRules(config: unknown): RoleRule[] {
    const items = Array.isArray(config) ? config : config && typeof config === 'object' ? Object.values(config) : [];
    const rules: RoleRule[] = [];
    for (const item of items as (RoleRuleConfig | null)[]) {
        const role = typeof item?.role === 'string' ? item.role.trim() : '';
        if (!item || !role) {
            continue;
        }
        rules.push({
            pattern: patternToRegExp(role),
            rule: {
                deadband: toNumber(item.deadband, 0),
                relative: item.relative === true,
                minInterval: toNumber(item.minInterval, 0) * SECOND,
                heartbeat: toNumber(item.heartbeat, 0) * MINUTE,
            },
        });
    }
    return rules;
}

/**
 * The rule for a number without `states`: a role rule of the settings, else the default of the
 * role. An absolute dead band of a value with a range of at most 1 (e.g. a dimmer 0..1) is
 * applied as hundredth.
 *
 * @param common common of the state
 * @param common.role the role
 * @param common.min the minimum, if known
 * @param common.max the maximum, if known
 * @param roleRules the role rules of the settings
 */
export function filterRuleFor(
    common: { role?: string; min?: number; max?: number },
    roleRules: RoleRule[] = [],
): FilterRule {
    const role = common.role || '';
    const own = roleRules.find(r => r.pattern.test(role));
    if (own) {
        return own.rule;
    }
    const rule =
        DEFAULT_RULES.find(d => d.roles.some(r => role === r || role.startsWith(`${r}.`)))?.rule || OTHER_NUMBERS;
    if (
        !rule.relative &&
        rule.deadband &&
        typeof common.min === 'number' &&
        typeof common.max === 'number' &&
        common.max - common.min <= 1
    ) {
        return { ...rule, deadband: rule.deadband / 100 };
    }
    return rule;
}

/** True if `val` differs enough from the stored value `base` */
export function isSignificant(rule: FilterRule, base: number | null, val: number | null): boolean {
    if (base === null || val === null) {
        return base !== val;
    }
    const delta = Math.abs(val - base);
    if (!rule.deadband) {
        return delta > 0;
    }
    const limit = rule.relative ? (Math.abs(base) * rule.deadband) / 100 : rule.deadband;
    // a tolerance for the binary representation: 20.0 -> 20.2 is a change of 0.2
    return delta > 0 && delta >= limit - 1e-9;
}

interface FilterState {
    /** A value was stored (or is the base after the start) */
    hasBase: boolean;
    base: number | null;
    baseTs: number;
    /** The latest change that was not stored */
    held: RecordedEvent | null;
    /** Start of the minute of the burst counter */
    minute: number;
    /** Stored changes in this minute */
    inMinute: number;
}

/**
 * Decides which changes are stored ("Frequenzfilter"). Changes reach the filter only if the value
 * or the ack changed. For class "discrete" every change is stored; for "continuous" the rule
 * applies: a change smaller than the dead band is held back, a change within the minimum interval
 * waits until the interval is over (the latest value wins), and a change within the dead band is
 * stored after the heartbeat. Ack changes without a value change are not stored for "continuous".
 *
 * Every datapoint is throttled to `burstLimit` stored changes per minute (a defective sensor, a
 * flapping contact); the latest value is stored in the next minute.
 */
export class ChangeFilter {
    private readonly states = new Map<number, FilterState>();
    /** Called when a datapoint is throttled, once per minute */
    public onThrottle: ((dp: number) => void) | null = null;

    public constructor(public burstLimit: number) {}

    private stateOf(dp: number): FilterState {
        let state = this.states.get(dp);
        if (!state) {
            state = { hasBase: false, base: null, baseTs: 0, held: null, minute: 0, inMinute: 0 };
            this.states.set(dp, state);
        }
        return state;
    }

    /** The value at the start, which is in the keyframe: changes are compared with it */
    public setBase(dp: number, val: number | null, ts: number): void {
        const state = this.stateOf(dp);
        if (!state.hasBase) {
            state.hasBase = true;
            state.base = val;
            state.baseTs = ts;
        }
    }

    private store(state: FilterState, event: RecordedEvent): RecordedEvent {
        state.hasBase = true;
        state.base = event.val;
        state.baseTs = event.ts;
        state.held = null;
        state.inMinute++;
        return event;
    }

    /** True if the burst limit of the minute of `ts` is reached */
    private isThrottled(state: FilterState, ts: number, filter: DpFilter): boolean {
        if (!filter.burst || !this.burstLimit) {
            return false;
        }
        const minute = Math.floor(ts / MINUTE) * MINUTE;
        if (minute !== state.minute) {
            state.minute = minute;
            state.inMinute = 0;
        }
        return state.inMinute >= this.burstLimit;
    }

    /**
     * Offers a change.
     *
     * @param event the change
     * @param filter how the datapoint is filtered
     * @returns the event if it is to be stored now, else `null` (held back or dropped)
     */
    public offer(event: RecordedEvent, filter: DpFilter): RecordedEvent | null {
        const state = this.stateOf(event.dp);
        if (this.isThrottled(state, event.ts, filter)) {
            if (state.inMinute === this.burstLimit && !state.held) {
                this.onThrottle?.(event.dp);
            }
            state.held = event;
            return null;
        }
        const rule = filter.rule;
        if (!rule || !state.hasBase) {
            return this.store(state, event);
        }
        if (isSignificant(rule, state.base, event.val)) {
            if (event.ts - state.baseTs >= rule.minInterval) {
                return this.store(state, event);
            }
        } else if (rule.heartbeat && event.ts - state.baseTs >= rule.heartbeat && event.val !== state.base) {
            return this.store(state, event);
        }
        state.held = event;
        return null;
    }

    /**
     * The held changes whose time has come: the minimum interval or the heartbeat is over, or the
     * minute of a throttled datapoint.
     *
     * @param now the current time
     * @param filterOf the filter of a datapoint; `undefined` if it is not recorded anymore
     */
    public due(now: number, filterOf: (dp: number) => DpFilter | undefined): RecordedEvent[] {
        const events: RecordedEvent[] = [];
        for (const [dp, state] of this.states) {
            const held = state.held;
            if (!held) {
                continue;
            }
            const filter = filterOf(dp);
            if (!filter) {
                this.states.delete(dp);
                continue;
            }
            if (this.isThrottled(state, now, filter)) {
                continue;
            }
            const rule = filter.rule;
            if (
                !rule ||
                !state.hasBase ||
                (isSignificant(rule, state.base, held.val) && now - state.baseTs >= rule.minInterval) ||
                (rule.heartbeat && now - state.baseTs >= rule.heartbeat && held.val !== state.base)
            ) {
                events.push(this.store(state, held));
            }
        }
        return events;
    }

    /** On unload: the held changes that differ from the stored value, so the last state is known */
    public takeHeld(): RecordedEvent[] {
        const events: RecordedEvent[] = [];
        for (const state of this.states.values()) {
            const held = state.held;
            if (held && (held.val !== state.base || !state.hasBase || held.sval !== null)) {
                events.push(this.store(state, held));
            }
        }
        return events;
    }

    /** Forgets a datapoint (not recorded anymore, or its class changed) */
    public remove(dp: number): void {
        this.states.delete(dp);
    }
}

/**
 * Counts the value changes per datapoint, to classify high-frequency datapoints. A measurement
 * covers the time from one `close()` to the next (normally one hour).
 */
export class RateMeter {
    private counts = new Map<number, number>();

    public constructor(private start: number) {}

    public count(dp: number): void {
        this.counts.set(dp, (this.counts.get(dp) || 0) + 1);
    }

    /**
     * Ends the measurement and returns the changes per minute of every given datapoint, or `null`
     * if the measurement was shorter than `minDuration` (it then continues).
     *
     * @param now the current time
     * @param dps the datapoints to report, also those without changes
     * @param minDuration the shortest meaningful measurement
     */
    public close(now: number, dps: Iterable<number>, minDuration = 15 * MINUTE): Map<number, number> | null {
        const duration = now - this.start;
        if (duration < minDuration) {
            return null;
        }
        const minutes = duration / MINUTE;
        const result = new Map<number, number>();
        for (const dp of dps) {
            result.set(dp, Math.round(((this.counts.get(dp) || 0) / minutes) * 100) / 100);
        }
        this.counts = new Map();
        this.start = now;
        return result;
    }
}

/**
 * The next classification of a datapoint after a measurement: high-frequency above `highRate`
 * changes per minute; back to normal only below half of it, so that a datapoint near the limit
 * does not switch every hour.
 *
 * @param previous the classification so far
 * @param perMin the measured changes per minute
 * @param highRate the limit of the settings
 * @param now the end of the measurement
 */
export function nextRate(previous: RateInfo | undefined, perMin: number, highRate: number, now: number): RateInfo {
    const high = previous?.high ? perMin >= highRate / 2 : perMin > highRate;
    return { perMin, maxPerMin: Math.max(previous?.maxPerMin ?? 0, perMin), high, ts: now };
}
