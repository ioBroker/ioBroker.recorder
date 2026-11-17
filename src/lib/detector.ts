/*
 * Anomaly detection at run time: hourly statistics into the profile, daily profiles and baselines
 * anew, every minute the lasting conditions, at once the events. The rules are in `anomaly.ts`.
 */
import {
    activeDurations,
    AnomalyTracker,
    AWAY_CATEGORIES,
    hasLevel,
    isActive,
    isLearned,
    isRacing,
    LONG_CATEGORIES,
    longLimit,
    percentile,
    poolProfile,
    RARE_CATEGORIES,
    rareActivity,
    ratesLearned,
    silentLimit,
    unusualValue,
    usualGap,
    neighbourHours,
    dayHours,
    type AnomalySettings,
    type HourProfile,
} from './anomaly';
import { backfillRange, backfillStatistics } from './backfill';
import { escapeHtml, format } from './preview';
import { hourOfWeek, ProfileBuilder, WEEK_HOURS, type HourStats, type StatHourRow } from './stats';
import type { Storage } from './storage';
import { DpClass, type AnomalyRecord, type AnomalyRule, type Baseline, type DpInfo } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The profile is computed from this many weeks */
export const PROFILE_WEEKS = 8;
/** Statistics and anomalies are kept this long */
export const STATISTICS_DAYS = 365;
/** Rows of the admin table at most */
const MAX_ROWS = 200;

/** What the adapter provides */
export interface DetectorHost {
    log: ioBroker.Logger;
    storage(): Storage | null;
    /** The recorded datapoints */
    datapoints(): DpInfo[];
    /** The current value (booleans 0/1) */
    value(dp: number): number | null;
    /** The absence state reports absence (`null`: none configured) */
    away(): boolean | null;
    /** The outdoor temperature, `null` if unknown */
    outdoorTemperature(): Promise<{ val: number; name: string } | null>;
    /** A new anomaly: notifications */
    notify(anomaly: AnomalyRecord, text: string): Promise<void>;
    /** The open anomalies changed */
    report(open: AnomalyRecord[]): Promise<void>;
    now(): number;
    /** Gives the event loop a chance during long computations */
    pause(): Promise<void>;
}

const TEXTS = {
    en: {
        value: '%label: %val, usually %min to %max at this time',
        rare: '%label: %what at %time, rare at this time',
        away: '%label: %what at %time while nobody is at home',
        silent: '%label: no update for %duration (usually every %gap)',
        long: '%label: %state for %duration (usually at most %usual)',
        cold: '%label: open while it is %temp °C outside (%outdoor)',
        racing: '%label: %changes changes in the last hour (usually %usual)',
        throttled: '%label: changes more than %limit times per minute (defective sensor?)',
        what: { windowsDoors: 'opened', motion: 'motion', light: 'switched on' } as Record<string, string>,
        state: { windowsDoors: 'open', light: 'on' } as Record<string, string>,
        rules: {
            value: 'Unusual value',
            rare: 'Rare activity',
            silent: 'Silent sensor',
            long: 'Unusually long',
            cold: 'Window open in the cold',
            racing: 'Racing datapoint',
        } as Record<AnomalyRule, string>,
        disabled: 'The anomaly detection is switched off; the statistics are collected anyway.',
        learning:
            'Profiles: %learned of %total datapoints are learned. The others learn their usual behaviour for %days days (complete from %ready).',
        learned: 'Profiles: all %total datapoints are learned.',
        backfill: 'The statistics before %date were computed from the existing recording.',
        rates: 'The rules "Silent sensor" and "Racing datapoint" need the counted updates, which only the running instance collects: they start on %ready.',
        open: 'Open anomalies',
        recent: 'Last 7 days',
        none: 'None.',
        time: 'Time',
        rule: 'Rule',
        text: 'Description',
        status: 'Status',
        isOpen: 'open',
        isOver: 'over',
        isAck: 'acknowledged',
        minutes: '%n min',
        hours: '%n h',
        days: '%n days',
    },
    de: {
        value: '%label: %val, sonst %min bis %max zu dieser Zeit',
        rare: '%label: %what um %time, selten zu dieser Zeit',
        away: '%label: %what um %time, obwohl niemand zu Hause ist',
        silent: '%label: seit %duration keine Meldung (sonst alle %gap)',
        long: '%label: seit %duration %state (sonst höchstens %usual)',
        cold: '%label: offen bei %temp °C draußen (%outdoor)',
        racing: '%label: %changes Änderungen in der letzten Stunde (sonst %usual)',
        throttled: '%label: ändert sich öfter als %limit-mal pro Minute (defekter Sensor?)',
        what: { windowsDoors: 'geöffnet', motion: 'Bewegung', light: 'eingeschaltet' } as Record<string, string>,
        state: { windowsDoors: 'offen', light: 'an' } as Record<string, string>,
        rules: {
            value: 'Ungewöhnlicher Wert',
            rare: 'Seltene Aktivität',
            silent: 'Stiller Sensor',
            long: 'Ungewöhnlich lange',
            cold: 'Fenster offen bei Kälte',
            racing: 'Rasender Datenpunkt',
        } as Record<AnomalyRule, string>,
        disabled: 'Die Anomalieerkennung ist ausgeschaltet; die Statistik wird trotzdem gesammelt.',
        learning:
            'Profile: %learned von %total Datenpunkten sind gelernt. Die übrigen lernen %days Tage lang ihr übliches Verhalten (vollständig ab %ready).',
        learned: 'Profile: alle %total Datenpunkte sind gelernt.',
        backfill: 'Die Statistik vor dem %date wurde aus der vorhandenen Aufzeichnung nachberechnet.',
        rates: 'Die Regeln „Stiller Sensor“ und „Rasender Datenpunkt“ brauchen die gezählten Meldungen, die nur die laufende Instanz erfasst: sie starten am %ready.',
        open: 'Offene Anomalien',
        recent: 'Letzte 7 Tage',
        none: 'Keine.',
        time: 'Zeit',
        rule: 'Regel',
        text: 'Beschreibung',
        status: 'Status',
        isOpen: 'offen',
        isOver: 'vorbei',
        isAck: 'quittiert',
        minutes: '%n Min.',
        hours: '%n Std.',
        days: '%n Tage',
    },
};

type Texts = (typeof TEXTS)['en'];

function textsOf(lang: ioBroker.Languages): Texts {
    return lang === 'de' ? TEXTS.de : TEXTS.en;
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function timeOf(ts: number): string {
    const date = new Date(ts);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateTimeOf(ts: number): string {
    const date = new Date(ts);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${timeOf(ts)}`;
}

/** A number with at most two decimals */
function num(val: number, lang: ioBroker.Languages): string {
    const rounded = Math.round(val * 100) / 100;
    return lang === 'de' ? String(rounded).replace('.', ',') : String(rounded);
}

/** "45 min", "5.5 h", "3 days" */
export function durationText(ms: number, lang: ioBroker.Languages): string {
    const t = textsOf(lang);
    if (ms < HOUR) {
        return format(t.minutes, { n: Math.max(1, Math.round(ms / MINUTE)) });
    }
    if (ms < 2 * DAY) {
        return format(t.hours, { n: num(Math.round((ms / HOUR) * 10) / 10, lang) });
    }
    return format(t.days, { n: num(Math.round((ms / DAY) * 10) / 10, lang) });
}

/** "Living room Window" */
function labelOf(dp: DpInfo): string {
    const room = dp.room ? dp.room.split(',')[0].trim() : '';
    const name = dp.name || dp.oid;
    return room && !name.startsWith(room) ? `${room} ${name}` : name;
}

function withUnit(val: number, dp: DpInfo, lang: ioBroker.Languages): string {
    return dp.unit ? `${num(val, lang)} ${dp.unit}` : num(val, lang);
}

/**
 * The anomaly detection of one instance. Statistics and profiles are kept also when it is
 * switched off, so that it works at once when it is switched on.
 */
export class AnomalyDetector {
    private readonly tracker: AnomalyTracker;
    private baselines = new Map<number, Baseline>();
    /** The profile of every datapoint around the loaded hour of the week */
    private profiles = new Map<number, HourProfile>();
    private profileHow = -1;
    /** The running rebuild of the profiles */
    private rebuilding: Promise<void> | null = null;
    /** Rebuild again after the running one (new statistics came in) */
    private rebuildAgain = false;

    public constructor(
        private readonly host: DetectorHost,
        private readonly stats: HourStats,
        public settings: AnomalySettings,
        public enabled: boolean,
        private readonly lang: ioBroker.Languages,
    ) {
        this.tracker = new AnomalyTracker(
            {
                insertAnomaly: anomaly => this.host.storage()?.insertAnomaly(anomaly) ?? 0,
                updateAnomaly: (id, endTs, ackTs) => this.host.storage()?.updateAnomaly(id, endTs, ackTs),
            },
            settings.quietHours * HOUR,
        );
    }

    private get texts(): Texts {
        return textsOf(this.lang);
    }

    /** Loads baselines, profiles and open anomalies (`prepare` computes what is missing) */
    public async start(): Promise<void> {
        const storage = this.host.storage();
        if (!storage) {
            return;
        }
        const now = this.host.now();
        this.baselines = storage.loadBaselines().baselines;
        this.tracker.restore(
            storage.readAnomalies(0, now + 1, 'running'),
            storage.readAnomalies(now - this.tracker.quiet, now + 1),
        );
        this.loadProfiles(now, true);
        await this.report();
    }

    /** Profiles of all datapoints around the current hour of the week */
    private loadProfiles(now: number, force = false): void {
        const how = hourOfWeek(now);
        const storage = this.host.storage();
        if (!storage || (how === this.profileHow && !force)) {
            return;
        }
        const hows = [...new Set([...neighbourHours(how), ...dayHours(how)])];
        const profiles = new Map<number, HourProfile>();
        for (const [dp, cells] of storage.readProfile(hows)) {
            profiles.set(dp, poolProfile(cells, how));
        }
        this.profiles = profiles;
        this.profileHow = how;
    }

    /**
     * Every full hour: stores the statistics of the hour (also when the detection is off) and
     * looks for racing datapoints.
     *
     * @param rows the statistics of the hour
     */
    public async onHour(rows: StatHourRow[]): Promise<void> {
        const storage = this.host.storage();
        if (!storage || !rows.length) {
            return;
        }
        try {
            storage.writeStatHours(rows);
        } catch (e) {
            this.host.log.error(`Cannot store the hourly statistics: ${(e as Error).message}`);
            return;
        }
        if (!this.enabled || !this.settings.racing) {
            return;
        }
        const now = this.host.now();
        for (const row of rows) {
            const baseline = this.baselines.get(row.dp);
            if (
                baseline &&
                ratesLearned(baseline, now, this.settings.learnDays) &&
                isRacing(row.changes, baseline, this.settings.racingFactor)
            ) {
                const dp = storage.getDpById(row.dp);
                await this.raise(
                    this.tracker.event(row.dp, 'racing', now, () => ({
                        text: format(this.texts.racing, {
                            label: dp ? labelOf(dp) : String(row.dp),
                            changes: row.changes,
                            usual: num(Math.round((baseline.changes / baseline.hours) * 10) / 10, this.lang),
                        }),
                        val: row.changes,
                    })),
                    dp,
                );
            }
        }
    }

    /**
     * In the background after the start: the statistics before the first live hour from the
     * recording (once; an interrupted run continues at the next start), then the profiles if they
     * are new or older than a day.
     *
     * @param liveStart start of the running hour of the live statistics
     */
    public async prepare(liveStart: number): Promise<void> {
        const storage = this.host.storage();
        if (!storage) {
            return;
        }
        let computed = false;
        const range = backfillRange(storage, liveStart, this.host.now(), PROFILE_WEEKS * 7);
        if (range) {
            const started = Date.now();
            this.host.log.info(
                `Anomaly detection: computing the statistics from ${dateTimeOf(range.from)} to ${dateTimeOf(range.to)} from the recording`,
            );
            const result = await backfillStatistics(
                storage,
                range,
                () => this.host.pause(),
                () => this.host.storage() !== storage,
            );
            if (!result) {
                return;
            }
            computed = true;
            this.host.log.info(
                `Anomaly detection: statistics of ${result.hours} hours (${result.rows} rows) computed in ${
                    Math.round((Date.now() - started) / 100) / 10
                } s`,
            );
        }
        const ts = storage.loadBaselines().ts;
        if (computed || ts === null || this.host.now() - ts > DAY) {
            await this.rebuild();
        }
    }

    /**
     * Daily: profiles and baselines anew from the last `PROFILE_WEEKS` weeks (so they forget older
     * weeks: seasons); deletes statistics and anomalies older than `STATISTICS_DAYS`. Reads and
     * writes in small steps with pauses. A call during a rebuild runs it once more afterwards.
     */
    public rebuild(): Promise<void> {
        if (this.rebuilding) {
            this.rebuildAgain = true;
            return this.rebuilding;
        }
        this.rebuilding = (async () => {
            try {
                do {
                    this.rebuildAgain = false;
                    await this.computeProfiles();
                } while (this.rebuildAgain && this.host.storage());
            } finally {
                this.rebuilding = null;
            }
        })();
        return this.rebuilding;
    }

    private async computeProfiles(): Promise<void> {
        const storage = this.host.storage();
        if (!storage) {
            return;
        }
        const aborted = (): boolean => this.host.storage() !== storage;
        const now = this.host.now();
        const from = now - PROFILE_WEEKS * 7 * DAY;
        const started = Date.now();
        try {
            // the statistics in steps of 6 hours
            const builder = new ProfileBuilder();
            for (let t = from; t <= now; t += 6 * HOUR) {
                for (const row of storage.readStatHourRange(t, t + 6 * HOUR)) {
                    builder.add(row);
                }
                await this.host.pause();
                if (aborted()) {
                    return;
                }
            }
            const baselines = new Map<number, Baseline>();
            for (const [dp, base] of builder.baselines()) {
                baselines.set(dp, { ...base, onP95: 0, onCount: 0 });
            }

            // durations of the active state of windows, doors and lights, week by week
            const dps = this.host
                .datapoints()
                .filter(
                    dp => LONG_CATEGORIES.has(dp.category || '') && dp.cls === DpClass.Discrete && dp.type !== 'string',
                );
            if (dps.length) {
                const byDp = new Map<number, { ts: number; val: number | null }[]>();
                const filter = { dps: dps.map(dp => dp.id) };
                for (let t = from; t <= now; t += 7 * DAY) {
                    for (const event of storage.readAllEvents(t, Math.min(t + 7 * DAY, now + 1), filter)) {
                        let list = byDp.get(event.dp);
                        if (!list) {
                            list = [];
                            byDp.set(event.dp, list);
                        }
                        list.push({ ts: event.ts, val: event.val });
                    }
                    await this.host.pause();
                    if (aborted()) {
                        return;
                    }
                }
                for (const [dp, events] of byDp) {
                    const baseline = baselines.get(dp);
                    if (baseline) {
                        const durations = activeDurations(
                            events,
                            storage.readValueBefore(dp, events[0].ts)?.val ?? null,
                        );
                        baseline.onCount = durations.length;
                        baseline.onP95 = Math.round(percentile(durations, 0.95));
                    }
                }
            }

            // the profile hour by hour of the week
            for (let how = 0; how < WEEK_HOURS; how++) {
                storage.writeProfileHour(how, builder.hour(how));
                if (how % 8 === 7) {
                    await this.host.pause();
                    if (aborted()) {
                        return;
                    }
                }
            }
            storage.saveBaselines(baselines, now);
            this.baselines = baselines;
            const trimmed = storage.trimStatistics(now - STATISTICS_DAYS * DAY);
            this.host.log.debug(
                `Profiles of ${baselines.size} datapoints computed in ${Date.now() - started} ms${
                    trimmed ? `, ${trimmed} old statistics deleted` : ''
                }`,
            );
        } catch (e) {
            this.host.log.error(`Cannot compute the profiles: ${(e as Error).message}`);
        }
        if (!aborted()) {
            this.loadProfiles(this.host.now(), true);
        }
    }

    private ruleEnabled(rule: AnomalyRule): boolean {
        return this.enabled && this.settings[rule];
    }

    /** Every minute: the lasting conditions (value, silent, long, cold) */
    public async check(): Promise<void> {
        if (!this.enabled || !this.host.storage()) {
            return;
        }
        const now = this.host.now();
        this.loadProfiles(now);
        const s = this.settings;
        const dps = this.host.datapoints();
        const raised: [AnomalyRecord | null, DpInfo][] = [];
        const outdoor = s.cold ? await this.host.outdoorTemperature() : null;
        for (const dp of dps) {
            const baseline = this.baselines.get(dp.id);
            const learned = isLearned(baseline, now, s.learnDays);
            const limit = baseline && ratesLearned(baseline, now, s.learnDays) ? silentLimit(baseline, s) : null;
            const last = this.stats.lastUpdate(dp.id);
            const silent = limit !== null && last !== null && now - last > limit;
            if (s.value && hasLevel(dp)) {
                const val = this.host.value(dp.id);
                const profile = this.profiles.get(dp.id);
                // the last value of a silent sensor is no measurement
                const unusual = learned && val !== null && !silent ? unusualValue(val, profile, s.zScore) : null;
                raised.push([
                    this.tracker.condition(dp.id, 'value', !!unusual, now, s.valueMinutes * MINUTE, () => ({
                        text: format(this.texts.value, {
                            label: labelOf(dp),
                            val: withUnit(val ?? 0, dp, this.lang),
                            min: withUnit(profile?.min ?? 0, dp, this.lang),
                            max: withUnit(profile?.max ?? 0, dp, this.lang),
                        }),
                        val,
                    })),
                    dp,
                ]);
            }
            if (s.silent) {
                raised.push([
                    this.tracker.condition(dp.id, 'silent', silent, now, 0, () => ({
                        text: format(this.texts.silent, {
                            label: labelOf(dp),
                            duration: durationText(now - (last ?? now), this.lang),
                            gap: durationText(baseline ? (usualGap(baseline) ?? 0) : 0, this.lang),
                        }),
                        val: null,
                    })),
                    dp,
                ]);
            }
            if (s.long && LONG_CATEGORIES.has(dp.category || '')) {
                const limit = learned && baseline ? longLimit(baseline, s) : null;
                const since = this.stats.onSince(dp.id);
                const long = limit !== null && since !== null && now - since > limit;
                raised.push([
                    this.tracker.condition(dp.id, 'long', long, now, 0, () => ({
                        text: format(this.texts.long, {
                            label: labelOf(dp),
                            state: this.texts.state[dp.category || ''] || this.texts.state.light,
                            duration: durationText(now - (since ?? now), this.lang),
                            usual: durationText(baseline?.onP95 ?? 0, this.lang),
                        }),
                        val: this.host.value(dp.id),
                    })),
                    dp,
                ]);
            }
            if (s.cold && dp.category === 'windowsDoors') {
                const open = this.stats.onSince(dp.id) !== null;
                const cold = open && outdoor !== null && outdoor.val < s.coldTemp;
                raised.push([
                    this.tracker.condition(dp.id, 'cold', cold, now, s.coldMinutes * MINUTE, () => ({
                        text: format(this.texts.cold, {
                            label: labelOf(dp),
                            temp: num(outdoor?.val ?? 0, this.lang),
                            outdoor: outdoor?.name ?? '',
                        }),
                        val: outdoor?.val ?? null,
                    })),
                    dp,
                ]);
            }
        }
        const recorded = new Set(dps.map(dp => dp.id));
        this.tracker.expire(now, anomaly => !recorded.has(anomaly.dp) || !this.ruleEnabled(anomaly.rule));
        for (const [anomaly, dp] of raised) {
            if (anomaly) {
                await this.raise(anomaly, dp, false);
            }
        }
        await this.report();
    }

    /**
     * A datapoint changed its value: rare activity (a door at 3 am, any motion while away).
     *
     * @param dp the datapoint
     * @param val the new value
     * @param wasActive the value before was active
     */
    public async onChange(dp: DpInfo, val: number | null, wasActive: boolean): Promise<void> {
        if (
            !this.enabled ||
            !this.settings.rare ||
            dp.cls !== DpClass.Discrete ||
            !RARE_CATEGORIES.has(dp.category || '') ||
            !isActive(val) ||
            wasActive
        ) {
            return;
        }
        const now = this.host.now();
        this.loadProfiles(now);
        const away = this.host.away() === true && AWAY_CATEGORIES.has(dp.category || '');
        if (
            !away &&
            !(
                isLearned(this.baselines.get(dp.id), now, this.settings.learnDays) &&
                rareActivity(this.profiles.get(dp.id), this.settings.rareShare)
            )
        ) {
            return;
        }
        await this.raise(
            this.tracker.event(dp.id, 'rare', now, () => ({
                text: format(away ? this.texts.away : this.texts.rare, {
                    label: labelOf(dp),
                    what: this.texts.what[dp.category || ''] || this.texts.what.light,
                    time: timeOf(now),
                }),
                val,
            })),
            dp,
        );
    }

    /**
     * A datapoint is throttled because it changes too often: racing, without waiting for a
     * profile.
     *
     * @param dp `dp.id`
     * @param limit changes per minute
     */
    public async onThrottle(dp: number, limit: number): Promise<void> {
        if (!this.ruleEnabled('racing')) {
            return;
        }
        const info = this.host.storage()?.getDpById(dp);
        await this.raise(
            this.tracker.event(dp, 'racing', this.host.now(), () => ({
                text: format(this.texts.throttled, { label: info ? labelOf(info) : String(dp), limit }),
                val: null,
            })),
            info,
        );
    }

    private async raise(anomaly: AnomalyRecord | null, dp: DpInfo | undefined, report = true): Promise<void> {
        if (!anomaly) {
            return;
        }
        this.host.log.info(`Anomaly (${anomaly.rule}): ${anomaly.text}${dp ? ` [${dp.oid}]` : ''}`);
        try {
            await this.host.notify(anomaly, anomaly.text);
        } catch (e) {
            this.host.log.warn(`Cannot send the notification: ${(e as Error).message}`);
        }
        if (report) {
            await this.report();
        }
    }

    /**
     * Acknowledges one or all open anomalies; the number acknowledged.
     *
     * @param id the ID, `null` for all
     */
    public async ack(id: number | null): Promise<number> {
        const count = this.tracker.ack(id, this.host.now());
        if (count) {
            await this.report();
        }
        return count;
    }

    /** The open anomalies, newest first */
    public open(): AnomalyRecord[] {
        return this.enabled ? this.tracker.list() : [];
    }

    private async report(): Promise<void> {
        try {
            await this.host.report(this.open());
        } catch (e) {
            this.host.log.warn(`Cannot update the anomaly states: ${(e as Error).message}`);
        }
    }

    /** What is usual for one datapoint: the baseline and the profile of all 168 hours of the week */
    public profileOf(dp: DpInfo): {
        id: string;
        name: string | null;
        learned: boolean;
        ratesLearned: boolean;
        baseline: Baseline | null;
        profile: {
            how: number;
            n: number;
            mean: number | null;
            sd: number | null;
            min: number | null;
            max: number | null;
            pActive: number;
            avgChanges: number;
        }[];
    } {
        const storage = this.host.storage();
        const cells = storage?.readProfile(null, dp.id).get(dp.id) ?? new Map();
        const baseline = this.baselines.get(dp.id) ?? null;
        const profile = [];
        for (let how = 0; how < 168; how++) {
            const c = cells.get(how);
            if (c) {
                profile.push({
                    how,
                    n: c.n,
                    mean: c.mean,
                    sd: c.nVal > 1 ? Math.sqrt(c.m2 / (c.nVal - 1)) : null,
                    min: c.min,
                    max: c.max,
                    pActive: c.pActive,
                    avgChanges: c.avgChanges,
                });
            }
        }
        return {
            id: dp.oid,
            name: dp.name,
            learned: isLearned(baseline ?? undefined, this.host.now(), this.settings.learnDays),
            ratesLearned: ratesLearned(baseline ?? undefined, this.host.now(), this.settings.learnDays),
            baseline,
            profile,
        };
    }

    /** The HTML of the admin tab "Anomalies": learning status, open and recent anomalies */
    public renderInfo(): string {
        const t = this.texts;
        const storage = this.host.storage();
        const now = this.host.now();
        const html: string[] = [];
        if (!this.enabled) {
            html.push(`<p>${escapeHtml(t.disabled)}</p>`);
        }
        const dps = this.host.datapoints();
        const learned = dps.filter(dp => isLearned(this.baselines.get(dp.id), now, this.settings.learnDays));
        if (learned.length === dps.length) {
            html.push(`<p>${escapeHtml(format(t.learned, { total: dps.length }))}</p>`);
        } else {
            let latest = now;
            for (const dp of dps) {
                const baseline = this.baselines.get(dp.id);
                if (!isLearned(baseline, now, this.settings.learnDays)) {
                    latest = Math.max(latest, (baseline?.since ?? now) + this.settings.learnDays * DAY);
                }
            }
            html.push(
                `<p>${escapeHtml(
                    format(t.learning, {
                        learned: learned.length,
                        total: dps.length,
                        days: this.settings.learnDays,
                        ready: dateTimeOf(latest).substring(0, 10),
                    }),
                )}</p>`,
            );
        }
        if (!storage) {
            return html.join('');
        }
        const bounds = storage.statHourBounds();
        if (bounds.lastBackfill !== null) {
            const until = bounds.firstLive ?? bounds.lastBackfill + HOUR;
            html.push(`<p>${escapeHtml(format(t.backfill, { date: dateTimeOf(until) }))}</p>`);
            let ready = 0;
            for (const dp of dps) {
                const baseline = this.baselines.get(dp.id);
                if (!ratesLearned(baseline, now, this.settings.learnDays)) {
                    ready = Math.max(ready, (baseline?.liveSince ?? until) + (this.settings.learnDays * DAY) / 2);
                }
            }
            if (ready > now) {
                html.push(`<p>${escapeHtml(format(t.rates, { ready: dateTimeOf(ready).substring(0, 10) }))}</p>`);
            }
        }
        const cell = 'style="padding: 2px 8px; border-bottom: 1px solid rgba(128,128,128,0.3); text-align: left"';
        const table = (anomalies: AnomalyRecord[], withStatus: boolean): string => {
            if (!anomalies.length) {
                return `<p>${escapeHtml(t.none)}</p>`;
            }
            const head = [t.time, t.rule, t.text, ...(withStatus ? [t.status] : [])];
            const rows = anomalies.slice(0, MAX_ROWS).map(a => {
                const status = a.ackTs !== null ? t.isAck : a.endTs !== null ? t.isOver : t.isOpen;
                const values = [dateTimeOf(a.ts), t.rules[a.rule] || a.rule, a.text, ...(withStatus ? [status] : [])];
                return `<tr>${values.map(v => `<td ${cell}>${escapeHtml(v)}</td>`).join('')}</tr>`;
            });
            return `<table style="border-collapse: collapse; width: 100%; font-size: 0.9em"><tr>${head
                .map(h => `<th ${cell}>${escapeHtml(h)}</th>`)
                .join('')}</tr>${rows.join('')}</table>`;
        };
        html.push(`<h4>${escapeHtml(t.open)}</h4>`, table(this.open(), false));
        html.push(`<h4>${escapeHtml(t.recent)}</h4>`, table(storage.readAnomalies(now - 7 * DAY, now + 1), true));
        return html.join('');
    }
}
