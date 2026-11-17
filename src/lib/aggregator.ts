export const AGG_INTERVAL = 300_000; // 5 minutes

/** One row of the table `agg5` */
export interface AggregateRow {
    /** Start of the 5 minute interval */
    ts: number;
    dp: number;
    min: number;
    max: number;
    avg: number;
    last: number;
}

interface Bucket {
    ts: number;
    min: number;
    max: number;
    sum: number;
    count: number;
    last: number;
}

/**
 * Collects the values of high-frequency datapoints into 5 minute intervals (min, max, mean of the
 * samples, last value). An interval is emitted when a value of a later interval arrives or when
 * the interval is over at the time of a write.
 */
export class Aggregator {
    private readonly buckets = new Map<number, Bucket>();
    private closed: AggregateRow[] = [];

    public add(dp: number, ts: number, value: number): void {
        const start = Math.floor(ts / AGG_INTERVAL) * AGG_INTERVAL;
        let bucket = this.buckets.get(dp);
        if (bucket && bucket.ts !== start) {
            if (start < bucket.ts) {
                // a late value of an interval that is already closed: ignore it
                return;
            }
            this.closed.push(Aggregator.toRow(dp, bucket));
            bucket = undefined;
        }
        if (!bucket) {
            this.buckets.set(dp, { ts: start, min: value, max: value, sum: value, count: 1, last: value });
            return;
        }
        if (value < bucket.min) {
            bucket.min = value;
        }
        if (value > bucket.max) {
            bucket.max = value;
        }
        bucket.sum += value;
        bucket.count++;
        bucket.last = value;
    }

    /** Returns all intervals that are over at `now` and removes them */
    public takeClosed(now: number): AggregateRow[] {
        for (const [dp, bucket] of this.buckets) {
            if (bucket.ts + AGG_INTERVAL <= now) {
                this.closed.push(Aggregator.toRow(dp, bucket));
                this.buckets.delete(dp);
            }
        }
        const rows = this.closed;
        this.closed = [];
        return rows;
    }

    /** Returns everything, also the running intervals (on unload) */
    public takeAll(): AggregateRow[] {
        for (const [dp, bucket] of this.buckets) {
            this.closed.push(Aggregator.toRow(dp, bucket));
        }
        this.buckets.clear();
        const rows = this.closed;
        this.closed = [];
        return rows;
    }

    /** Puts rows back that could not be written */
    public restore(rows: AggregateRow[]): void {
        this.closed = rows.concat(this.closed);
    }

    /** The intervals of a datapoint that are not written yet, also the running one */
    public pending(dp: number): AggregateRow[] {
        const rows = this.closed.filter(row => row.dp === dp);
        const bucket = this.buckets.get(dp);
        if (bucket) {
            rows.push(Aggregator.toRow(dp, bucket));
        }
        return rows;
    }

    /** All intervals that are not written yet, also the running ones */
    public pendingAll(): AggregateRow[] {
        const rows = [...this.closed];
        for (const [dp, bucket] of this.buckets) {
            rows.push(Aggregator.toRow(dp, bucket));
        }
        return rows;
    }

    /** Forgets a datapoint that is no longer recorded */
    public remove(dp: number): void {
        this.buckets.delete(dp);
    }

    private static toRow(dp: number, bucket: Bucket): AggregateRow {
        return {
            ts: bucket.ts,
            dp,
            min: bucket.min,
            max: bucket.max,
            avg: bucket.sum / bucket.count,
            last: bucket.last,
        };
    }
}
