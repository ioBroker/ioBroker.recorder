/*
 * Statistics of the past, computed from the recording: when the statistics start (a new
 * installation of M6, or an update), the hourly statistics of the recorded weeks are computed from
 * the events, keyframes and 5 minute aggregates, so the profiles do not wait for the learning period.
 *
 * The recording does not know updates without a change of value nor changes held back by the
 * frequency filter. The rows are marked (`stat_hour.bf = 1`); the baseline takes updates, changes
 * and gaps from the live statistics only (silent sensor, racing datapoint).
 */
import { HourStats, hourFloor, type StatHourRow } from './stats';
import type { Storage } from './storage';
import type { KeyframeRow } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Computed and stored in steps of 2 hours, with a pause after each (~50 ms for 1500 datapoints) */
const STEP = 2 * HOUR;

export interface BackfillRange {
    /** First hour to compute */
    from: number;
    /** End: the first hour of the live statistics */
    to: number;
}

export interface BackfillResult extends BackfillRange {
    /** Hours with rows (hours without a keyframe: the instance was not running) */
    hours: number;
    rows: number;
}

/**
 * The hours the statistics lack: from the start of the recording, or after the last computed hour
 * if a backfill was interrupted, up to the first live hour. `null` if nothing is missing.
 *
 * @param storage the storage
 * @param liveStart start of the running hour of the live statistics
 * @param now now
 * @param maxDays not further back than this
 */
export function backfillRange(storage: Storage, liveStart: number, now: number, maxDays: number): BackfillRange | null {
    const bounds = storage.statHourBounds();
    const to = Math.min(bounds.firstLive ?? liveStart, liveStart);
    let from: number;
    if (bounds.lastBackfill !== null && bounds.lastBackfill < to) {
        from = bounds.lastBackfill + HOUR;
    } else {
        const oldest = storage.oldestTs();
        if (oldest === null) {
            return null;
        }
        // the first full hour of the recording
        from = Math.ceil(oldest / HOUR) * HOUR;
    }
    from = Math.max(from, hourFloor(now - maxDays * DAY));
    return to - from >= HOUR ? { from, to } : null;
}

/** One step of the recording, in the order of time */
type Step =
    | { ts: number; kind: 0; rows: KeyframeRow[] }
    | { ts: number; kind: 1; dp: number; val: number | null; sval: string | null }
    | { ts: number; kind: 2; dp: number; avg: number; min: number; max: number };

/**
 * Computes the hourly statistics of `range` from the recording and stores them step by step (so
 * an interrupted run continues where it stopped).
 *
 * @param storage the storage
 * @param range the hours to compute
 * @param pause called after every step: gives the event loop a chance
 * @param aborted true if the instance stops; checked after every pause
 * @returns `null` if aborted
 */
export async function backfillStatistics(
    storage: Storage,
    range: BackfillRange,
    pause: () => Promise<void>,
    aborted: () => boolean,
): Promise<BackfillResult | null> {
    const stats = new HourStats(range.from);
    const values = new Map<number, { val: number | null; sval: string | null }>();

    // the values at the start: the keyframe before, and the events after it
    const keyframe = storage.keyframeAtOrBefore(range.from);
    let lastKeyframe = keyframe;
    if (keyframe !== null) {
        for (const row of storage.readKeyframe(keyframe)) {
            values.set(row.dp, { val: row.val, sval: row.sval });
        }
        for (const event of storage.readAllEvents(keyframe + 1, range.from)) {
            values.set(event.dp, { val: event.val, sval: event.sval });
        }
        for (const [dp, value] of values) {
            stats.init(dp, value.val, range.from, range.from);
        }
    }

    const result: BackfillResult = { ...range, hours: 0, rows: 0 };
    let rows: StatHourRow[] = [];
    // a keyframe is written every full hour and at the start: an hour without one was not recorded
    let recorded = false;
    // the 5 minute aggregates hold the minimum and maximum of all samples
    const extremes = new Map<number, { min: number; max: number }>();

    const closeUntil = (ts: number): void => {
        while (ts >= stats.start + HOUR) {
            const hourRows = stats.close(stats.start + HOUR);
            if (recorded) {
                for (const row of hourRows) {
                    const extreme = extremes.get(row.dp);
                    if (extreme) {
                        row.min = extreme.min;
                        row.max = extreme.max;
                    }
                }
                rows.push(...hourRows);
                result.hours++;
            }
            recorded = false;
            extremes.clear();
        }
    };

    const change = (dp: number, ts: number, val: number | null, sval: string | null): void => {
        const before = values.get(dp);
        stats.update(dp, ts, val, !before || before.val !== val || before.sval !== sval);
        values.set(dp, { val, sval });
    };

    for (let begin = range.from; begin < range.to; begin += STEP) {
        const end = Math.min(begin + STEP, range.to);
        const steps: Step[] = [];
        for (const kf of storage.readKeyframes(begin, end)) {
            steps.push({ ts: kf.ts, kind: 0, rows: kf.rows });
        }
        for (const event of storage.readAllEvents(begin, end)) {
            steps.push({ ts: event.ts, kind: 1, dp: event.dp, val: event.val, sval: event.sval });
        }
        for (const agg of storage.readAllAggregates(begin, end)) {
            steps.push({ ts: agg.ts, kind: 2, dp: agg.dp, avg: agg.avg, min: agg.min, max: agg.max });
        }
        // stable: at the same time the keyframe first
        steps.sort((a, b) => a.ts - b.ts || a.kind - b.kind);

        for (const step of steps) {
            closeUntil(step.ts);
            if (step.kind === 0) {
                recorded = true;
                // The keyframe of a start (not at the full hour, or after a gap) knows the changes
                // while the instance was not running. An hourly one holds the latest values, also
                // those within the dead band or the samples of aggregated datapoints: the events
                // and aggregates are the truth then.
                const start =
                    step.ts % HOUR >= MINUTE || lastKeyframe === null || step.ts - lastKeyframe > HOUR + 5 * MINUTE;
                lastKeyframe = step.ts;
                // the recorded datapoints: the others were removed from the selection
                const present = new Set(step.rows.map(row => row.dp));
                for (const dp of stats.ids()) {
                    if (!present.has(dp)) {
                        stats.remove(dp);
                        values.delete(dp);
                    }
                }
                for (const row of step.rows) {
                    if (!values.has(row.dp)) {
                        stats.init(row.dp, row.val, step.ts, step.ts);
                        values.set(row.dp, { val: row.val, sval: row.sval });
                    } else if (start) {
                        const before = values.get(row.dp);
                        if (before?.val !== row.val || before?.sval !== row.sval) {
                            change(row.dp, step.ts, row.val, row.sval);
                        }
                    }
                }
            } else if (step.kind === 1) {
                change(step.dp, step.ts, step.val, step.sval);
            } else {
                change(step.dp, step.ts, step.avg, null);
                const known = extremes.get(step.dp);
                extremes.set(step.dp, {
                    min: known ? Math.min(known.min, step.min) : step.min,
                    max: known ? Math.max(known.max, step.max) : step.max,
                });
            }
        }
        closeUntil(end);
        if (rows.length) {
            storage.writeStatHours(rows, true);
            result.rows += rows.length;
            rows = [];
        }
        await pause();
        if (aborted()) {
            return null;
        }
    }
    return result;
}
