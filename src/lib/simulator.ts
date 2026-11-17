/*
 * Presence simulation at run time: plans the simulated day from the recording, switches at the
 * planned times and stops at once. The rules are in `simulation.ts`.
 */
import { escapeHtml, format } from './preview';
import {
    actionsPerWindow,
    addWindows,
    collectActions,
    isOn,
    isSimulatable,
    MIN_DAY_ACTIONS,
    pickSourceDay,
    planDay,
    sunsetShift,
    windowStart,
    type PlannedAction,
    type SimulationSettings,
} from './simulation';
import type { Storage } from './storage';
import type { DpInfo, RecordedEvent } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The timer is armed for at most this long, so that a suspended system does not lose the plan */
const MAX_WAIT = HOUR;
/** An action that is due longer than this (a suspended system) is skipped, not caught up */
const LATE = 5 * MINUTE;
/** Rows of the preview at most */
const MAX_ROWS = 500;

export interface SimulatorSettings extends SimulationSettings {
    /** Only log, switch nothing */
    dryRun: boolean;
}

/** What the adapter provides */
export interface SimulationHost {
    log: ioBroker.Logger;
    /** `from` of the commands of this instance */
    ownFrom: string;
    storage(): Storage | null;
    /** The recorded datapoints */
    datapoints(): DpInfo[];
    /** `common` of an object */
    common(oid: string): Partial<ioBroker.StateCommon> | undefined;
    getState(oid: string): Promise<ioBroker.State | null | undefined>;
    /** Writes a command (`ack: false`) marked as coming from the simulation */
    setState(oid: string, val: boolean | number): Promise<void>;
    /** Shows the status in `simulation.*` */
    report(status: SimulationStatus): Promise<void>;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
    now(): number;
    random(): number;
}

export interface SimulationStatus {
    active: boolean;
    /** Date of the recorded day that is played, `''` if none */
    sourceDay: string;
    /** "21:14 Living room Ceiling light: off" */
    nextAction: string;
    lastAction: string;
}

/** The plan of one simulated day */
export interface DayPlan {
    /** Start of the simulated day (local noon) */
    start: number;
    /** Start of the recorded day that is played; `null`: no day at home recorded yet */
    source: number | null;
    /** True if `source` is the same weekday, false for the fallback to any day at home */
    sameWeekday: boolean;
    /** ms the afternoon and evening are shifted by the sunset */
    sunsetShift: number;
    actions: PlannedAction[];
    /** Value of each switchable datapoint at the start of the recorded day */
    initial: Map<number, number | null>;
}

const TEXTS = {
    en: {
        on: 'on',
        off: 'off',
        none: 'No day at home is recorded yet: the simulation needs at least one day on which lights or blinds were switched (%min actions).',
        source: 'Simulated day from %start: plays %source (%how), %count actions.',
        sameWeekday: 'same weekday',
        fallback: 'no same weekday at home recorded, another day',
        sunset: 'Afternoon and evening shifted by %shift min (sunset).',
        switchable: '%count states may be switched (lights, blinds%media); heating, locks, sockets and gates never.',
        media: ', media',
        time: 'Time',
        recorded: 'Recorded',
        room: 'Room',
        name: 'Name',
        value: 'Value',
        kind: 'Who',
        kinds: { user: 'user interface', script: 'script', device: 'on the device' },
        more: '... and %n more',
        past: 'Grey: already over today, not caught up.',
    },
    de: {
        on: 'an',
        off: 'aus',
        none: 'Noch kein Tag mit Anwesenheit aufgezeichnet: Die Simulation braucht mindestens einen Tag, an dem Lichter oder Rollläden geschaltet wurden (%min Aktionen).',
        source: 'Simulierter Tag ab %start: spielt %source ab (%how), %count Aktionen.',
        sameWeekday: 'gleicher Wochentag',
        fallback: 'kein gleicher Wochentag mit Anwesenheit aufgezeichnet, ein anderer Tag',
        sunset: 'Nachmittag und Abend um %shift min verschoben (Sonnenuntergang).',
        switchable:
            '%count Datenpunkte dürfen geschaltet werden (Lichter, Rollläden%media); Heizung, Schlösser, Steckdosen und Tore nie.',
        media: ', Medien',
        time: 'Zeit',
        recorded: 'Aufgezeichnet',
        room: 'Raum',
        name: 'Name',
        value: 'Wert',
        kind: 'Wer',
        kinds: { user: 'Oberfläche', script: 'Skript', device: 'am Gerät' },
        more: '... und %n weitere',
        past: 'Grau: heute schon vorbei, wird nicht nachgeholt.',
    },
};

function textsOf(lang: ioBroker.Languages): (typeof TEXTS)['en'] {
    return lang === 'de' ? TEXTS.de : TEXTS.en;
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** "21:14" in local time */
function timeOf(ts: number): string {
    const date = new Date(ts);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "2026-11-10" in local time */
export function dateOf(ts: number): string {
    const date = new Date(ts);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "2026-11-10 (Tue)" */
function dayLabel(ts: number, lang: ioBroker.Languages): string {
    let weekday: string;
    try {
        weekday = new Date(ts).toLocaleDateString(lang, { weekday: 'short' });
    } catch {
        weekday = new Date(ts).toLocaleDateString('en', { weekday: 'short' });
    }
    return `${dateOf(ts)} (${weekday}) ${timeOf(ts)}`;
}

/** The switchable datapoints */
export function switchableDps(
    dps: DpInfo[],
    common: (oid: string) => Partial<ioBroker.StateCommon> | undefined,
    media: boolean,
): DpInfo[] {
    return dps.filter(dp => isSimulatable(dp, common(dp.oid), media));
}

/**
 * Plans the simulated day starting at `start` from the recording of the switchable datapoints.
 *
 * @param storage the storage
 * @param dps the switchable datapoints
 * @param start start of the simulated day (local noon)
 * @param settings the settings
 * @param random a random number in [0, 1)
 */
export function planSimulatedDay(
    storage: Storage,
    dps: DpInfo[],
    start: number,
    settings: SimulationSettings,
    random: () => number,
): DayPlan {
    const plan: DayPlan = {
        start,
        source: null,
        sameWeekday: false,
        sunsetShift: 0,
        actions: [],
        initial: new Map(),
    };
    const oldest = storage.oldestTs();
    if (!dps.length || oldest === null || oldest >= start) {
        return plan;
    }
    const events = storage.readAllEvents(windowStart(oldest), start, { dps: dps.map(dp => dp.id) });
    // the value before the first event of each datapoint, so that only real changes count
    const before = new Map<number, number | null>();
    for (const event of events) {
        if (!before.has(event.dp)) {
            before.set(event.dp, storage.readValueBefore(event.dp, event.ts)?.val ?? null);
        }
    }
    for (const [dp, val] of before) {
        if (val === null) {
            before.delete(dp);
        }
    }
    const actions = collectActions(
        events,
        src => (src === null ? undefined : storage.getSource(src)?.kind),
        before,
        settings.scripts,
    );
    const picked = pickSourceDay(start, actionsPerWindow(actions), settings.weeks, random);
    if (!picked) {
        return plan;
    }
    const source = picked.start;
    plan.source = source;
    plan.sameWeekday = picked.sameWeekday;
    plan.sunsetShift = sunsetShift(source, start, settings);
    plan.actions = planDay(actions, source, start, { jitter: settings.jitter, sunsetShift: plan.sunsetShift }, random);
    for (const dp of dps) {
        plan.initial.set(dp.id, storage.readValueBefore(dp.id, source)?.val ?? null);
    }
    return plan;
}

/** The text of a value: on/off, or the number with its unit */
function valueText(dp: DpInfo, val: number, lang: ioBroker.Languages): string {
    const t = textsOf(lang);
    if (dp.type === 'boolean') {
        return val ? t.on : t.off;
    }
    return dp.unit ? `${val} ${dp.unit}` : String(val);
}

/** "21:14 Living room Ceiling light: off" */
function actionText(dp: DpInfo, val: number, ts: number, lang: ioBroker.Languages): string {
    const where = dp.room ? `${dp.room.split(',')[0]} ` : '';
    return `${timeOf(ts)} ${where}${dp.name || dp.oid}: ${valueText(dp, val, lang)}`;
}

/**
 * The HTML of the plan for the `textSendTo` control of the tab "Simulation".
 *
 * @param plan the plan
 * @param storage the storage, for the names
 * @param switchable how many datapoints may be switched
 * @param media media may be switched
 * @param now the present: earlier actions are shown grey
 * @param lang the language
 */
export function renderPlan(
    plan: DayPlan,
    storage: Storage,
    switchable: number,
    media: boolean,
    now: number,
    lang: ioBroker.Languages,
): string {
    const t = textsOf(lang);
    const cell = 'style="padding: 2px 8px; border-bottom: 1px solid rgba(128,128,128,0.3); text-align: left"';
    const html: string[] = [];
    html.push(`<p>${escapeHtml(format(t.switchable, { count: switchable, media: media ? t.media : '' }))}</p>`);
    if (plan.source === null) {
        html.push(`<p><b>${escapeHtml(format(t.none, { min: MIN_DAY_ACTIONS }))}</b></p>`);
        return html.join('');
    }
    html.push(
        `<p><b>${escapeHtml(
            format(t.source, {
                start: dayLabel(plan.start, lang),
                source: dayLabel(plan.source, lang),
                how: plan.sameWeekday ? t.sameWeekday : t.fallback,
                count: plan.actions.length,
            }),
        )}</b>`,
    );
    if (plan.sunsetShift) {
        html.push(`<br/>${escapeHtml(format(t.sunset, { shift: Math.round(plan.sunsetShift / MINUTE) }))}`);
    }
    html.push(`<br/>${escapeHtml(t.past)}</p>`);
    html.push('<table style="border-collapse: collapse; width: 100%; font-size: 0.9em">');
    html.push(
        `<tr>${[t.time, t.recorded, t.room, t.name, t.value, t.kind].map(h => `<th ${cell}>${escapeHtml(h)}</th>`).join('')}</tr>`,
    );
    for (const action of plan.actions.slice(0, MAX_ROWS)) {
        const dp = storage.getDpById(action.dp);
        if (!dp) {
            continue;
        }
        const past = action.ts < now ? ' style="opacity: 0.5"' : '';
        html.push(
            `<tr${past}>${[
                `${dateOf(action.ts)} ${timeOf(action.ts)}`,
                `${dateOf(action.sourceTs)} ${timeOf(action.sourceTs)}`,
                dp.room ? dp.room.split(',')[0] : '',
                dp.name || dp.oid,
                valueText(dp, action.val, lang),
                t.kinds[action.kind],
            ]
                .map(v => `<td ${cell}>${escapeHtml(v)}</td>`)
                .join('')}</tr>`,
        );
    }
    html.push('</table>');
    if (plan.actions.length > MAX_ROWS) {
        html.push(`<p>${escapeHtml(format(t.more, { n: plan.actions.length - MAX_ROWS }))}</p>`);
    }
    return html.join('');
}

/**
 * The running simulation. `start` plans the current simulated day and switches from now on;
 * nothing of the past is caught up. `stop` clears the timer before anything else, then switches
 * off the lights and media that the simulation switched on.
 */
export class PresenceSimulation {
    private active = false;
    private plan: DayPlan | null = null;
    /** Index of the next action of `plan` */
    private next = 0;
    private timer: unknown = null;
    /** Lights and media the simulation switched on, by object ID */
    private readonly switchedOn = new Set<string>();
    private lastAction = '';

    public constructor(
        private readonly host: SimulationHost,
        public settings: SimulatorSettings,
        private readonly lang: ioBroker.Languages,
    ) {}

    public get running(): boolean {
        return this.active;
    }

    /** The plan of the current simulated day, if running */
    public get currentPlan(): DayPlan | null {
        return this.plan;
    }

    /**
     * Starts the simulation from now on.
     *
     * @param reason for the log
     * @param resume it ran before a restart: the lights it switched on are taken from the recording
     */
    public async start(reason: string, resume = false): Promise<void> {
        if (this.active) {
            return;
        }
        this.active = true;
        this.lastAction = '';
        this.host.log.info(`Presence simulation started (${reason})${this.settings.dryRun ? ', dry run' : ''}`);
        if (resume) {
            this.recoverSwitchedOn();
        }
        const now = this.host.now();
        await this.beginDay(windowStart(now), now, false);
    }

    /**
     * It ran before a restart, but meanwhile somebody came home: switches off the lights and
     * media it switched on, as `stop` would have done.
     *
     * @param reason for the log
     */
    public async finishAfterRestart(reason: string): Promise<void> {
        if (this.active) {
            return;
        }
        this.recoverSwitchedOn();
        this.host.log.info(`Presence simulation stopped (${reason})`);
        const switchedOn = [...this.switchedOn];
        this.switchedOn.clear();
        await this.switchOff(switchedOn);
    }

    /** The lights and media whose last command (within 2 days) came from the simulation and switched them on */
    private recoverSwitchedOn(): void {
        const storage = this.host.storage();
        if (!storage) {
            return;
        }
        try {
            const dps = this.switchable().filter(dp => dp.category === 'light' || dp.category === 'media');
            const now = this.host.now();
            const lastCommand = new Map<number, RecordedEvent>();
            for (const event of storage.readAllEvents(now - 2 * DAY, now + 1, { dps: dps.map(dp => dp.id) })) {
                if (!event.ack) {
                    lastCommand.set(event.dp, event);
                }
            }
            for (const dp of dps) {
                const command = lastCommand.get(dp.id);
                if (
                    command?.src != null &&
                    isOn(command.val) &&
                    storage.getSource(command.src)?.from === this.host.ownFrom
                ) {
                    this.switchedOn.add(dp.oid);
                }
            }
        } catch (e) {
            this.host.log.warn(`Presence simulation: cannot read the recording: ${(e as Error).message}`);
        }
    }

    public async stop(reason: string): Promise<void> {
        if (!this.active) {
            return;
        }
        // first of all: nothing more happens
        this.active = false;
        this.clearTimer();
        this.plan = null;
        this.host.log.info(`Presence simulation stopped (${reason})`);
        const switchedOn = [...this.switchedOn];
        this.switchedOn.clear();
        await this.switchOff(switchedOn);
        await this.report();
    }

    /** On unload: only the timer; the simulation continues after the restart */
    public dispose(): void {
        this.active = false;
        this.clearTimer();
    }

    private clearTimer(): void {
        if (this.timer) {
            this.host.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private switchable(): DpInfo[] {
        return switchableDps(this.host.datapoints(), oid => this.host.common(oid), this.settings.media);
    }

    /**
     * Plans the simulated day starting at `start`; actions before `from` are not caught up. On a new
     * day the lights the simulation switched on go off if they were off at the start of the newly
     * played day.
     */
    private async beginDay(start: number, from: number, newDay: boolean): Promise<void> {
        const storage = this.host.storage();
        let plan: DayPlan = {
            start,
            source: null,
            sameWeekday: false,
            sunsetShift: 0,
            actions: [],
            initial: new Map(),
        };
        if (storage) {
            try {
                plan = planSimulatedDay(storage, this.switchable(), start, this.settings, () => this.host.random());
            } catch (e) {
                this.host.log.error(`Presence simulation: cannot read the recording: ${(e as Error).message}`);
            }
        }
        if (!this.active) {
            return;
        }
        this.plan = plan;
        this.next = plan.actions.findIndex(action => action.ts >= from);
        if (this.next < 0) {
            this.next = plan.actions.length;
        }
        if (plan.source === null) {
            this.host.log.warn(
                'Presence simulation: no day at home recorded yet (lights or blinds switched), nothing is switched today',
            );
        } else {
            this.host.log.info(
                `Presence simulation: ${dateOf(start)} plays ${dateOf(plan.source)}, ` +
                    `${plan.actions.length - this.next} actions from now on`,
            );
        }
        if (newDay && storage) {
            const off = [...this.switchedOn].filter(oid => {
                const dp = storage.getDp(oid);
                return !dp || !isOn(plan.initial.get(dp.id) ?? null);
            });
            off.forEach(oid => this.switchedOn.delete(oid));
            await this.switchOff(off);
        }
        await this.report();
        this.schedule();
    }

    private schedule(): void {
        this.clearTimer();
        if (!this.active || !this.plan) {
            return;
        }
        const end = addWindows(this.plan.start, 1);
        const due = this.next < this.plan.actions.length ? this.plan.actions[this.next].ts : end;
        const wait = Math.min(Math.max(0, due - this.host.now()), MAX_WAIT);
        this.timer = this.host.setTimeout(() => {
            this.timer = null;
            void this.tick();
        }, wait);
    }

    private async tick(): Promise<void> {
        const now = this.host.now();
        while (this.active && this.plan && this.next < this.plan.actions.length) {
            const action = this.plan.actions[this.next];
            if (action.ts > now) {
                break;
            }
            this.next++;
            if (now - action.ts <= LATE) {
                await this.execute(action);
            }
        }
        if (!this.active || !this.plan) {
            return;
        }
        if (now >= addWindows(this.plan.start, 1)) {
            // normally the next day; after a suspended system the current one, without catching up
            await this.beginDay(windowStart(now), now, true);
            return;
        }
        await this.report();
        this.schedule();
    }

    private async execute(action: PlannedAction): Promise<void> {
        const dp = this.host.storage()?.getDpById(action.dp);
        // checked again: the object may have changed since the plan was made
        if (!dp || !this.active || !isSimulatable(dp, this.host.common(dp.oid), this.settings.media)) {
            return;
        }
        const val = dp.type === 'boolean' ? action.val !== 0 : action.val;
        const text = actionText(dp, action.val, action.ts, this.lang);
        try {
            const current = await this.host.getState(dp.oid);
            if (!this.active) {
                return;
            }
            const tracked = dp.category === 'light' || dp.category === 'media';
            if (current && (current.val === val || (typeof val === 'boolean' && current.val === Number(val)))) {
                this.host.log.debug(`Presence simulation: ${text} (already)`);
            } else if (this.settings.dryRun) {
                this.host.log.info(`Presence simulation (dry run): ${text}`);
            } else {
                await this.host.setState(dp.oid, val);
                this.host.log.debug(`Presence simulation: ${text}`);
                if (tracked && isOn(action.val)) {
                    this.switchedOn.add(dp.oid);
                    if (!this.active) {
                        // stopped while switching: the end state counts
                        this.switchedOn.delete(dp.oid);
                        await this.switchOff([dp.oid]);
                    }
                }
            }
            if (tracked && !isOn(action.val)) {
                this.switchedOn.delete(dp.oid);
            }
            this.lastAction = text;
        } catch (e) {
            this.host.log.warn(`Presence simulation cannot switch ${dp.oid}: ${(e as Error).message}`);
        }
    }

    /** Switches off the given lights and media, if they are on */
    private async switchOff(oids: string[]): Promise<void> {
        const storage = this.host.storage();
        for (const oid of oids) {
            const dp = storage?.getDp(oid);
            if (!dp) {
                continue;
            }
            try {
                const current = await this.host.getState(oid);
                const on = current?.val === true || (typeof current?.val === 'number' && current.val > 0);
                if (!on) {
                    continue;
                }
                if (this.settings.dryRun) {
                    this.host.log.info(`Presence simulation (dry run): ${dp.name || oid} off`);
                } else {
                    await this.host.setState(oid, dp.type === 'boolean' ? false : 0);
                    this.host.log.info(`Presence simulation: ${dp.name || oid} off`);
                }
            } catch (e) {
                this.host.log.warn(`Presence simulation cannot switch off ${oid}: ${(e as Error).message}`);
            }
        }
    }

    private async report(): Promise<void> {
        const plan = this.active ? this.plan : null;
        let nextAction = '';
        const next = plan?.actions[this.next];
        const dp = next ? this.host.storage()?.getDpById(next.dp) : undefined;
        if (next && dp) {
            nextAction = actionText(dp, next.val, next.ts, this.lang);
        }
        try {
            await this.host.report({
                active: this.active,
                sourceDay: plan?.source ? dateOf(plan.source) : '',
                nextAction,
                lastAction: this.lastAction,
            });
        } catch (e) {
            this.host.log.warn(`Presence simulation: cannot update the states: ${(e as Error).message}`);
        }
    }
}
