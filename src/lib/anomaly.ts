/*
 * Anomaly detection: the rules as pure functions over the weekly profile and the baselines, and the
 * bookkeeping of open anomalies (quiet time, acknowledgement). The timers are in `detector.ts`.
 */
import type { ProfileCell } from './stats';
import { DpClass, type AnomalyRecord, type AnomalyRule, type Baseline, type DpInfo } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK_HOURS = 168;

export interface AnomalySettings {
    value: boolean;
    rare: boolean;
    silent: boolean;
    long: boolean;
    cold: boolean;
    racing: boolean;
    /** A value is unusual above this z-score against the same hour of the week */
    zScore: number;
    /** ... if it stays unusual this many minutes */
    valueMinutes: number;
    /** Activity is rare in hours with activity in less than this share of the weeks (0..1) */
    rareShare: number;
    /** A datapoint is silent after this many hours without an update at least */
    silentHours: number;
    /** ... and this many times its usual interval */
    silentFactor: number;
    /** Open or on longer than this many times the 95th percentile of the usual duration */
    longFactor: number;
    /** Window open while it is colder outside than this, °C */
    coldTemp: number;
    /** ... for this many minutes */
    coldMinutes: number;
    /** Racing: this many times the usual changes per hour */
    racingFactor: number;
    /** At most one anomaly per datapoint and rule in this many hours */
    quietHours: number;
    /** The profile of a datapoint is used after this many days of statistics */
    learnDays: number;
}

export const DEFAULT_ANOMALY_SETTINGS: AnomalySettings = {
    value: true,
    rare: true,
    silent: true,
    long: true,
    cold: true,
    racing: true,
    zScore: 3,
    valueMinutes: 30,
    rareShare: 0.02,
    silentHours: 6,
    silentFactor: 4,
    longFactor: 1.5,
    coldTemp: 5,
    coldMinutes: 30,
    racingFactor: 10,
    quietHours: 12,
    learnDays: 14,
};

/** Categories in which activity can be rare (a door at 3 am) */
export const RARE_CATEGORIES = new Set(['windowsDoors', 'motion', 'light']);
/** Categories in which every activity is unusual while nobody is at home */
export const AWAY_CATEGORIES = new Set(['windowsDoors', 'motion']);
/** Categories that can be open or on for unusually long */
export const LONG_CATEGORIES = new Set(['windowsDoors', 'light']);
/** Rules that describe a lasting condition; the others are events */
export const CONDITION_RULES = new Set<AnomalyRule>(['value', 'silent', 'long', 'cold']);
/** An event (rare activity, racing) stays open this long unless it is acknowledged */
export const EVENT_OPEN = 12 * HOUR;

/** Counters, times and dates have no usual level: they grow or jump */
const NO_LEVEL_ROLE = /energy|consumption|counter|total|meter|time|date|duration|uptime/i;
const NO_LEVEL_UNIT = /^(k|m|g)?wh$|^m³$|^m3$|^l$|^h$|^s$|^ms$|^min$/i;

/** Does a datapoint have a level whose usual range can be learned (a temperature, a power)? */
export function hasLevel(dp: Pick<DpInfo, 'cls' | 'type' | 'role' | 'unit'>): boolean {
    return (
        (dp.cls === DpClass.Continuous || dp.cls === DpClass.Aggregated) &&
        dp.type === 'number' &&
        !NO_LEVEL_ROLE.test(dp.role || '') &&
        !NO_LEVEL_UNIT.test(dp.unit || '')
    );
}

/** Is the value active: on, open, motion? */
export function isActive(val: number | null | undefined): boolean {
    return val !== null && val !== undefined && val > 0;
}

/** Has a datapoint enough statistics for its profile? */
export function isLearned(baseline: Baseline | undefined, now: number, learnDays: number): boolean {
    return !!baseline && now - baseline.since >= learnDays * DAY;
}

/** The hour of the week and its neighbours */
export function neighbourHours(how: number): number[] {
    return [-1, 0, 1].map(k => (how + k + WEEK_HOURS) % WEEK_HOURS);
}

/** The same hour and its neighbours on all days of the week */
export function dayHours(how: number): number[] {
    const result: number[] = [];
    for (let day = 0; day < 7; day++) {
        for (const k of [-1, 0, 1]) {
            result.push((day * 24 + (how % 24) + k + WEEK_HOURS) % WEEK_HOURS);
        }
    }
    return result;
}

/** The profile of a datapoint around one hour of the week */
export interface HourProfile {
    /** Hours observed in the hour of the week and its neighbours */
    n: number;
    /** ... with a numeric mean */
    nVal: number;
    mean: number | null;
    /** Standard deviation of the hourly means */
    sd: number;
    /** Lowest and highest value seen in these hours */
    min: number | null;
    max: number | null;
    /** Share of these hours with a change */
    pWeek: number;
    /** Share of the hours with a change in the same hour of all days */
    pDay: number;
    /** Hours observed in the same hour of all days */
    nDay: number;
}

/**
 * Pools the profile cells of the hour of the week `how` and its neighbours (union of the
 * observations), and of the same hour on all days.
 *
 * @param cells the profile of one datapoint by hour of the week
 * @param how the hour of the week
 */
export function poolProfile(cells: Map<number, ProfileCell>, how: number): HourProfile {
    const week = neighbourHours(how)
        .map(h => cells.get(h))
        .filter((c): c is ProfileCell => !!c);
    let n = 0;
    let nVal = 0;
    let sum = 0;
    let active = 0;
    let min: number | null = null;
    let max: number | null = null;
    for (const c of week) {
        n += c.n;
        active += c.pActive * c.n;
        if (c.mean !== null && c.nVal) {
            nVal += c.nVal;
            sum += c.mean * c.nVal;
        }
        if (c.min !== null) {
            min = min === null ? c.min : Math.min(min, c.min);
        }
        if (c.max !== null) {
            max = max === null ? c.max : Math.max(max, c.max);
        }
    }
    const mean = nVal ? sum / nVal : null;
    let m2 = 0;
    if (mean !== null) {
        for (const c of week) {
            if (c.mean !== null && c.nVal) {
                m2 += c.m2 + c.nVal * (c.mean - mean) ** 2;
            }
        }
    }
    let nDay = 0;
    let activeDay = 0;
    for (const h of dayHours(how)) {
        const c = cells.get(h);
        if (c) {
            nDay += c.n;
            activeDay += c.pActive * c.n;
        }
    }
    return {
        n,
        nVal,
        mean,
        sd: nVal > 1 ? Math.sqrt(m2 / (nVal - 1)) : 0,
        min,
        max,
        pWeek: n ? active / n : 0,
        pDay: nDay ? activeDay / nDay : 0,
        nDay,
    };
}

/**
 * Is a value unusual for this hour of the week? Its z-score against the hourly means is above
 * `zScore` and it lies outside of everything seen in these hours.
 *
 * @param val the current value
 * @param profile the profile around the hour of the week
 * @param zScore the limit
 */
export function unusualValue(val: number, profile: HourProfile | undefined, zScore: number): { z: number } | null {
    if (!profile || profile.nVal < 6 || profile.mean === null || profile.min === null || profile.max === null) {
        return null;
    }
    if (val >= profile.min && val <= profile.max) {
        return null;
    }
    // a constant value has no deviation: 1 % of the level, at least a little
    const sd = Math.max(profile.sd, Math.abs(profile.mean) * 0.01, 1e-6);
    const z = (val - profile.mean) / sd;
    return Math.abs(z) > zScore ? { z } : null;
}

/**
 * Is activity rare at this time: in the hour of the week (and its neighbours) and in the same
 * hour of all days, less than `share` of the hours had a change?
 *
 * @param profile the profile around the hour of the week
 * @param share the limit, 0..1
 */
export function rareActivity(profile: HourProfile | undefined, share: number): boolean {
    if (!profile || profile.n < 6 || profile.nDay < 14) {
        return false;
    }
    return profile.pWeek < share && profile.pDay < share;
}

/** The usual time between two updates, ms */
export function usualGap(baseline: Baseline): number | null {
    return baseline.updates && baseline.hours ? (baseline.hours * HOUR) / baseline.updates : null;
}

/**
 * Time without an update after which a datapoint is silent; `null` for datapoints that report
 * too seldom for that (usually less often than every `silentHours`).
 *
 * @param baseline what is usual
 * @param settings the settings
 */
export function silentLimit(baseline: Baseline, settings: AnomalySettings): number | null {
    const gap = usualGap(baseline);
    if (gap === null || gap > settings.silentHours * HOUR) {
        return null;
    }
    return Math.max(settings.silentFactor * gap, settings.silentHours * HOUR, 1.5 * baseline.maxGap);
}

/**
 * Duration of the active state (open, on) after which it is unusually long; `null` if not enough
 * periods are known.
 *
 * @param baseline what is usual
 * @param settings the settings
 */
export function longLimit(baseline: Baseline, settings: AnomalySettings): number | null {
    if (baseline.onCount < 5 || !baseline.onP95) {
        return null;
    }
    return Math.max(settings.longFactor * baseline.onP95, 30 * MINUTE);
}

/**
 * Is a datapoint racing: far more changes in the last hour than usual (and at least one per
 * minute)?
 *
 * @param changes the changes in the last hour
 * @param baseline what is usual
 * @param factor times the usual changes per hour
 */
export function isRacing(changes: number, baseline: Baseline, factor: number): boolean {
    if (changes < 60 || !baseline.hours) {
        return false;
    }
    return changes > factor * Math.max(baseline.changes / baseline.hours, 1);
}

/**
 * The durations of the active periods (value > 0) in the events of one datapoint.
 *
 * @param events the events, sorted by time
 * @param initial the value before the first event
 */
export function activeDurations(events: { ts: number; val: number | null }[], initial: number | null): number[] {
    const durations: number[] = [];
    let since: number | null = null;
    let active = isActive(initial);
    for (const event of events) {
        const now = isActive(event.val);
        if (now && !active) {
            since = event.ts;
        } else if (!now && active && since !== null) {
            durations.push(event.ts - since);
            since = null;
        }
        active = now;
    }
    return durations;
}

/** The `p` percentile (0..1) of the values, nearest rank */
export function percentile(values: number[], p: number): number {
    if (!values.length) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Where the anomalies are kept */
export interface AnomalyStore {
    insertAnomaly(anomaly: Omit<AnomalyRecord, 'id'>): number;
    updateAnomaly(id: number, endTs: number | null, ackTs: number | null): void;
}

/**
 * The anomalies that are not over: a condition (value, silent, long, cold) is over when it no
 * longer holds, an event (rare, racing) after `EVENT_OPEN`. At most one anomaly per datapoint and
 * rule within the quiet time. An acknowledged condition is not raised again before it is over.
 */
export class AnomalyTracker {
    /** Not over, also acknowledged ones, by datapoint and rule */
    private readonly running = new Map<string, AnomalyRecord>();
    /** Since when a condition holds */
    private readonly pending = new Map<string, number>();
    /** When the last anomaly of a datapoint and rule was raised */
    private readonly lastRaised = new Map<string, number>();

    public constructor(
        private readonly store: AnomalyStore,
        public quiet: number,
    ) {}

    private static key(dp: number, rule: AnomalyRule): string {
        return `${dp}:${rule}`;
    }

    /**
     * After a start: the anomalies that are not over and the recent ones (quiet time).
     *
     * @param running anomalies without end
     * @param recent anomalies of the quiet time
     */
    public restore(running: AnomalyRecord[], recent: AnomalyRecord[]): void {
        for (const anomaly of recent) {
            const key = AnomalyTracker.key(anomaly.dp, anomaly.rule);
            this.lastRaised.set(key, Math.max(this.lastRaised.get(key) ?? 0, anomaly.ts));
        }
        for (const anomaly of running) {
            this.running.set(AnomalyTracker.key(anomaly.dp, anomaly.rule), { ...anomaly });
        }
    }

    /**
     * A lasting condition: an anomaly when it holds `minDuration`, over when it no longer holds.
     *
     * @param dp `dp.id`
     * @param rule the rule
     * @param holds the condition holds now
     * @param now the current time
     * @param minDuration how long it must hold
     * @param describe text and value of the anomaly
     * @returns the new anomaly, if any
     */
    public condition(
        dp: number,
        rule: AnomalyRule,
        holds: boolean,
        now: number,
        minDuration: number,
        describe: () => { text: string; val: number | null },
    ): AnomalyRecord | null {
        const key = AnomalyTracker.key(dp, rule);
        if (!holds) {
            this.pending.delete(key);
            this.end(key, now);
            return null;
        }
        const since = this.pending.get(key) ?? now;
        this.pending.set(key, since);
        if (now - since < minDuration || this.running.has(key)) {
            return null;
        }
        return this.raise(key, dp, rule, now, describe);
    }

    /**
     * An event: an anomaly at once, unless one is open or in the quiet time.
     *
     * @param dp `dp.id`
     * @param rule the rule
     * @param now the current time
     * @param describe text and value of the anomaly
     * @returns the new anomaly, if any
     */
    public event(
        dp: number,
        rule: AnomalyRule,
        now: number,
        describe: () => { text: string; val: number | null },
    ): AnomalyRecord | null {
        const key = AnomalyTracker.key(dp, rule);
        if (this.running.has(key)) {
            return null;
        }
        return this.raise(key, dp, rule, now, describe);
    }

    private raise(
        key: string,
        dp: number,
        rule: AnomalyRule,
        now: number,
        describe: () => { text: string; val: number | null },
    ): AnomalyRecord | null {
        const last = this.lastRaised.get(key);
        if (last !== undefined && now - last < this.quiet) {
            return null;
        }
        const { text, val } = describe();
        const record = { dp, rule, ts: now, endTs: null, ackTs: null, val, text };
        const anomaly: AnomalyRecord = { id: this.store.insertAnomaly(record), ...record };
        this.running.set(key, anomaly);
        this.lastRaised.set(key, now);
        return anomaly;
    }

    private end(key: string, now: number): void {
        const anomaly = this.running.get(key);
        if (anomaly) {
            anomaly.endTs = now;
            this.store.updateAnomaly(anomaly.id, now, anomaly.ackTs);
            this.running.delete(key);
        }
    }

    /**
     * Ends the events that are open long enough, and every anomaly the predicate names (a
     * datapoint no longer recorded, a rule switched off).
     *
     * @param now the current time
     * @param drop anomalies to end
     */
    public expire(now: number, drop?: (anomaly: AnomalyRecord) => boolean): void {
        for (const [key, anomaly] of [...this.running]) {
            if ((!CONDITION_RULES.has(anomaly.rule) && now - anomaly.ts >= EVENT_OPEN) || drop?.(anomaly)) {
                this.pending.delete(key);
                this.end(key, now);
            }
        }
    }

    /**
     * Acknowledges one or all open anomalies; the number acknowledged.
     *
     * @param id the ID, `null` for all
     * @param now the current time
     */
    public ack(id: number | null, now: number): number {
        let count = 0;
        for (const [key, anomaly] of [...this.running]) {
            if (anomaly.ackTs === null && (id === null || anomaly.id === id)) {
                anomaly.ackTs = now;
                count++;
                if (CONDITION_RULES.has(anomaly.rule)) {
                    this.store.updateAnomaly(anomaly.id, null, now);
                } else {
                    // an event is over with the acknowledgement
                    anomaly.endTs = now;
                    this.store.updateAnomaly(anomaly.id, now, now);
                    this.running.delete(key);
                }
            }
        }
        return count;
    }

    /** The open anomalies (neither over nor acknowledged), newest first */
    public list(): AnomalyRecord[] {
        return [...this.running.values()].filter(a => a.ackTs === null).sort((a, b) => b.ts - a.ts || b.id - a.id);
    }
}
