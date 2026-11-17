/**
 * Raw data is split into one SQLite file per ISO calendar week. Weeks are computed in **UTC**
 * (Monday 00:00 UTC to Monday 00:00 UTC), so the file of a timestamp does not depend on the time
 * zone or on daylight saving time of the host.
 */

const DAY = 86_400_000;
export const WEEK = 7 * DAY;

/** Name of the file that holds events of one week, e.g. `ev-2026-W47.sqlite` */
const FILE_REGEX = /^ev-(\d{4})-W(\d{2})\.sqlite$/;

/** ISO week of a timestamp, e.g. `{ year: 2026, week: 47 }` */
export function isoWeek(ts: number): { year: number; week: number } {
    const date = new Date(ts);
    // Thursday of the same ISO week decides the year
    const day = date.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
    const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day);
    const year = new Date(thursday).getUTCFullYear();
    const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK) + 1;
    return { year, week };
}

/** Week key of a timestamp, e.g. `2026-W47` */
export function weekKey(ts: number): string {
    const { year, week } = isoWeek(ts);
    return `${year}-W${week.toString().padStart(2, '0')}`;
}

/** Start (Monday 00:00 UTC) of the week that contains `ts` */
export function weekStart(ts: number): number {
    const date = new Date(ts);
    const day = date.getUTCDay() || 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1);
}

/** Start of an ISO week given by year and week number */
export function weekStartOf(year: number, week: number): number {
    // January 4th is always in week 1
    const jan4 = Date.UTC(year, 0, 4);
    return weekStart(jan4) + (week - 1) * WEEK;
}

/** File name for the week of `ts` */
export function weekFileName(ts: number): string {
    return `ev-${weekKey(ts)}.sqlite`;
}

/** Parses a week file name. Returns `null` for other files. */
export function parseWeekFileName(fileName: string): { key: string; start: number; end: number } | null {
    const m = FILE_REGEX.exec(fileName);
    if (!m) {
        return null;
    }
    const start = weekStartOf(parseInt(m[1], 10), parseInt(m[2], 10));
    return { key: `${m[1]}-W${m[2]}`, start, end: start + WEEK };
}
