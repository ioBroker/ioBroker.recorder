/*
 * Hourly statistics of every recorded datapoint (table `stat_hour`) and the weekly profile (table
 * `profile`: 168 hours of the week per datapoint) that the anomaly detection compares with.
 */

const HOUR = 3_600_000;

/** Local hour of the week: 0 = Monday 00:00 ... 167 = Sunday 23:00 */
export function hourOfWeek(ts: number): number {
    const date = new Date(ts);
    return ((date.getDay() + 6) % 7) * 24 + date.getHours();
}

/** One row of `stat_hour` */
export interface StatHourRow {
    /** Start of the hour */
    ts: number;
    dp: number;
    /** Local hour of the week of `ts` */
    how: number;
    min: number | null;
    max: number | null;
    /** Time-weighted mean */
    avg: number | null;
    last: number | null;
    /** Seconds in an active state (value > 0: on, open, motion) */
    onSec: number;
    /** Changes of value */
    changes: number;
    /** Updates, also without a change of value */
    updates: number;
    /** Longest time without an update that ended in this hour, ms */
    maxGap: number;
}

/** One row of `profile`: a datapoint in one hour of the week */
export interface ProfileCell {
    /** Hours observed */
    n: number;
    /** Hours with a numeric mean */
    nVal: number;
    mean: number | null;
    /** Sum of squared deviations (Welford) */
    m2: number;
    /** Share of the hours with at least one change */
    pActive: number;
    avgChanges: number;
    avgUpdates: number;
    min: number | null;
    max: number | null;
}

/**
 * Adds one hour to a profile cell (Welford's online algorithm for mean and variance).
 *
 * @param cell the cell so far, if any
 * @param row the statistics of the hour
 */
export function addToProfile(cell: ProfileCell | undefined, row: StatHourRow): ProfileCell {
    const next: ProfileCell = cell
        ? { ...cell }
        : { n: 0, nVal: 0, mean: null, m2: 0, pActive: 0, avgChanges: 0, avgUpdates: 0, min: null, max: null };
    next.n++;
    next.pActive += ((row.changes > 0 ? 1 : 0) - next.pActive) / next.n;
    next.avgChanges += (row.changes - next.avgChanges) / next.n;
    next.avgUpdates += (row.updates - next.avgUpdates) / next.n;
    if (row.avg !== null) {
        next.nVal++;
        const mean = next.mean ?? 0;
        const delta = row.avg - mean;
        next.mean = mean + delta / next.nVal;
        next.m2 += delta * (row.avg - next.mean);
    }
    if (row.min !== null) {
        next.min = next.min === null ? row.min : Math.min(next.min, row.min);
    }
    if (row.max !== null) {
        next.max = next.max === null ? row.max : Math.max(next.max, row.max);
    }
    return next;
}

/** Statistics of one datapoint in the running hour */
interface Running {
    /** Current value and since when it counts in this hour */
    val: number | null;
    since: number;
    integral: number;
    covered: number;
    onMs: number;
    min: number | null;
    max: number | null;
    changes: number;
    updates: number;
    maxGap: number;
    /** Time of the last update (across hours) */
    lastUpdate: number | null;
    /** Since when the value is active (> 0), across hours */
    onSince: number | null;
}

/** Collects the statistics of the running hour; `close` at every full hour gives the rows */
export class HourStats {
    private readonly running = new Map<number, Running>();

    public constructor(private hourStart: number) {}

    private get(dp: number): Running {
        let r = this.running.get(dp);
        if (!r) {
            r = {
                val: null,
                since: this.hourStart,
                integral: 0,
                covered: 0,
                onMs: 0,
                min: null,
                max: null,
                changes: 0,
                updates: 0,
                maxGap: 0,
                lastUpdate: null,
                onSince: null,
            };
            this.running.set(dp, r);
        }
        return r;
    }

    /**
     * The value when the recording starts.
     *
     * @param dp `dp.id`
     * @param val the value (booleans 0/1, `null` for texts)
     * @param ts time of the last update of the state
     * @param lc time of the last change of the state
     */
    public init(dp: number, val: number | null, ts: number, lc: number): void {
        const r = this.get(dp);
        if (r.lastUpdate !== null) {
            return;
        }
        r.val = val;
        r.min = val;
        r.max = val;
        r.lastUpdate = ts;
        r.onSince = val !== null && val > 0 ? lc || ts : null;
    }

    private integrate(r: Running, to: number): void {
        if (r.val !== null && to > r.since) {
            const duration = to - r.since;
            r.integral += r.val * duration;
            r.covered += duration;
            if (r.val > 0) {
                r.onMs += duration;
            }
        }
        r.since = Math.max(r.since, to);
    }

    /**
     * An update of a state, also without a change of value.
     *
     * @param dp `dp.id`
     * @param ts time of the update
     * @param val the value (booleans 0/1, `null` for texts)
     * @param changed the value changed
     */
    public update(dp: number, ts: number, val: number | null, changed: boolean): void {
        const r = this.get(dp);
        this.integrate(r, ts);
        r.updates++;
        if (r.lastUpdate !== null && ts > r.lastUpdate) {
            r.maxGap = Math.max(r.maxGap, ts - r.lastUpdate);
        }
        r.lastUpdate = Math.max(r.lastUpdate ?? ts, ts);
        if (!changed) {
            return;
        }
        r.changes++;
        if (val !== null) {
            r.min = r.min === null ? val : Math.min(r.min, val);
            r.max = r.max === null ? val : Math.max(r.max, val);
        }
        const wasOn = r.val !== null && r.val > 0;
        const isOn = val !== null && val > 0;
        if (isOn && !wasOn) {
            r.onSince = ts;
        } else if (!isOn) {
            r.onSince = null;
        }
        r.val = val;
    }

    /** Time of the last update, `null` if none is known */
    public lastUpdate(dp: number): number | null {
        return this.running.get(dp)?.lastUpdate ?? null;
    }

    /** Since when the value is active (on, open), `null` if it is not */
    public onSince(dp: number): number | null {
        return this.running.get(dp)?.onSince ?? null;
    }

    public remove(dp: number): void {
        this.running.delete(dp);
    }

    /**
     * Ends the running hour: one row per datapoint that had a value or an update.
     *
     * @param end the end of the hour (a full hour)
     */
    public close(end: number): StatHourRow[] {
        const start = this.hourStart;
        const how = hourOfWeek(start);
        const rows: StatHourRow[] = [];
        for (const [dp, r] of this.running) {
            this.integrate(r, end);
            if (r.covered > 0 || r.updates > 0) {
                rows.push({
                    ts: start,
                    dp,
                    how,
                    min: r.min,
                    max: r.max,
                    avg: r.covered > 0 ? r.integral / r.covered : null,
                    last: r.val,
                    onSec: Math.round(r.onMs / 1000),
                    changes: r.changes,
                    updates: r.updates,
                    maxGap: r.maxGap,
                });
            }
            r.integral = 0;
            r.covered = 0;
            r.onMs = 0;
            r.changes = 0;
            r.updates = 0;
            r.maxGap = 0;
            r.min = r.val;
            r.max = r.val;
            r.since = end;
        }
        this.hourStart = end;
        return rows;
    }

    /** Start of the running hour */
    public get start(): number {
        return this.hourStart;
    }
}

/** The full hour at or before `ts` */
export function hourFloor(ts: number): number {
    return Math.floor(ts / HOUR) * HOUR;
}
