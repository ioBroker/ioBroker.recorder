/*
 * Copyright (c) 2026 bluefox <dogafox@gmail.com>
 *
 * The MIT License (MIT)
 */
import * as utils from '@iobroker/adapter-core';
import { sendResponse, type IobDataEntry } from '@iobroker/aggregate';

import { Aggregator } from './lib/aggregator';
import { DEFAULT_ANOMALY_SETTINGS, isActive, type AnomalySettings } from './lib/anomaly';
import { categoryModes } from './lib/categories';
import {
    ChangeFilter,
    filterRuleFor,
    nextRate,
    parseRoleRules,
    RateMeter,
    type DpFilter,
    type RoleRule,
} from './lib/filter';
import { AnomalyDetector, type DetectorHost } from './lib/detector';
import { COMMANDS, HELP } from './lib/help';
import { parseHistoryRequest, readHistory, toTimestamp } from './lib/history';
import { estimateSize, renderHighFrequency, renderPreview, summaryText } from './lib/preview';
import {
    aliasTarget,
    computeSelection,
    DeviceDetection,
    type Candidate,
    type RecorderCustom,
    type SelectionConfig,
    type SelectionResult,
} from './lib/selection';
import { triggerMeansAway, windowStart } from './lib/simulation';
import {
    planSimulatedDay,
    PresenceSimulation,
    renderPlan,
    switchableDps,
    type SimulationHost,
    type SimulationStatus,
    type SimulatorSettings,
} from './lib/simulator';
import { classifySource } from './lib/source';
import { DRIVER_NAME } from './lib/sqlite';
import { HourStats, hourFloor } from './lib/stats';
import { Storage } from './lib/storage';
import {
    DpClass,
    type AnomalyRecord,
    type DpInfo,
    type Keyframe,
    type RateInfo,
    type RecordedEvent,
    type StoredValue,
} from './lib/types';
import { encodeValue, sameValue } from './lib/values';
import { readChanges, readEventList, readSnapshot, readTimeline, type PendingData } from './lib/walk';
import type { EventsRequest, SnapshotEntry, SnapshotRequest, TimelineRequest } from './lib/walk-types';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Allowed values of `retentionDays` */
const RETENTION_DAYS = [1, 7, 30, 90];
/** A batch of this size is written at once, without waiting for the flush interval */
const MAX_BATCH = 20_000;
/** If writing fails, at most this many events are kept in memory; older ones are dropped */
const MAX_BUFFER = 200_000;
/** Local time of the daily retention job */
const RETENTION_HOUR = 3;
const RETENTION_MINUTE = 30;
/** Object changes are collected for this time, then the selection is computed again */
const RESELECT_DELAY = 30_000;
/** Defaults of the frequency filter settings, changes per minute */
const DEFAULT_HIGH_RATE = 6;
const DEFAULT_BURST_LIMIT = 60;
/** At most one warning per throttled datapoint and hour */
const THROTTLE_LOG_INTERVAL = HOUR;
/** The replay moves forward once per second, by `speed` seconds */
const REPLAY_TICK = 1000;
const MIN_REPLAY_SPEED = 0.1;
const MAX_REPLAY_SPEED = 3600;
const DEFAULT_REPLAY_SPEED = 60;
/** Object types the selection looks at */
const SELECTION_TYPES = new Set<string>(['state', 'channel', 'device', 'folder', 'enum']);

/** Last value of a datapoint (also if the filter did not store it), to detect real changes and for keyframes */
interface CachedValue extends StoredValue {
    ack: boolean;
}

/** One entry of the answer to `getSelection` */
interface SelectionInfo {
    id: string;
    name: string | null;
    room: string | null;
    func: string | null;
    category: string | null;
    devType: string | null;
    cls: 'discrete' | 'continuous' | 'aggregated' | 'discarded';
    reason: string;
}

const CLASS_NAMES: SelectionInfo['cls'][] = ['discrete', 'continuous', 'aggregated', 'discarded'];

/** Milliseconds until the next local time `hour:minute` */
function msUntilLocal(hour: number, minute: number, now: Date = new Date()): number {
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}

/** Start of the current local day */
function localMidnight(now: Date = new Date()): number {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
}

/** `chips` stores an array; older or hand-edited configurations may hold a string or an object */
function toPatternList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
    }
    if (value && typeof value === 'object') {
        // a deep merge of the settings turns arrays into objects with the indexes as keys
        return Object.values(value).filter((v): v is string => typeof v === 'string');
    }
    if (typeof value === 'string') {
        return value.split(/[,;\n]/);
    }
    return [];
}

/** A checkbox of the settings; older or hand-edited configurations may hold a string */
function toBool(value: unknown, fallback: boolean): boolean {
    if (value === true || value === 'true') {
        return true;
    }
    if (value === false || value === 'false') {
        return false;
    }
    return fallback;
}

/** A whole number of the settings within `[min, max]` */
function toInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = Math.round(Number(value));
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

/** A number of the settings within `[min, max]` */
function toFloat(value: unknown, min: number, max: number, fallback: number): number {
    const n = typeof value === 'string' ? parseFloat(value.replace(',', '.')) : Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

function isSelectionObject(id: string, obj: ioBroker.Object | null | undefined): boolean {
    if (!obj || !SELECTION_TYPES.has(obj.type)) {
        return false;
    }
    return obj.type !== 'enum' || id.startsWith('enum.rooms.') || id.startsWith('enum.functions.');
}

class RecorderAdapter extends utils.Adapter {
    private storage: Storage | null = null;
    /** Objects the selection is computed from (states, channels, devices, folders, rooms, functions) */
    private objects: Record<string, ioBroker.Object> = {};
    /** Results of the type detector, updated incrementally after object changes */
    private detection: DeviceDetection | null = null;
    /** Last result of the detection, used by the preview */
    private detected: Map<string, Candidate> | null = null;
    /** Recorded datapoints by object ID */
    private readonly dps = new Map<string, DpInfo>();
    /** Why each datapoint is recorded */
    private readonly reasons = new Map<string, string>();
    /** Recorded alias by the ID it reads from: `getHistory` of the target answers from the alias */
    private readonly recordedAliases = new Map<string, string>();
    /** Last stored value per `dp.id` */
    private readonly cache = new Map<number, CachedValue>();
    private readonly aggregator = new Aggregator();
    /** Frequency filter: dead band, minimum interval, heartbeat, burst limit */
    private readonly filter = new ChangeFilter(DEFAULT_BURST_LIMIT);
    /** Filter of every recorded datapoint by `dp.id` */
    private readonly filters = new Map<number, DpFilter>();
    private roleRules: RoleRule[] = [];
    private highRate = DEFAULT_HIGH_RATE;
    /** Changes per minute, measured hourly */
    private rateMeter = new RateMeter(Date.now());
    /** Measured rates by `dp.id` */
    private rates = new Map<number, RateInfo>();
    /** Last throttle warning per `dp.id` */
    private readonly throttled = new Map<number, number>();
    /** Events not yet written */
    private buffer: RecordedEvent[] = [];
    private droppedEvents = 0;
    private eventsToday = 0;
    private lastDbSize = -1;
    private lastEventsToday = -1;
    private retentionDays = 30;
    private lang: ioBroker.Languages = 'en';
    private selectionRunning = false;
    private selectionPending = false;
    /** Replay: the current replay time, its speed (factor of real time) and its timer */
    private replayTime = 0;
    private replaySpeed = DEFAULT_REPLAY_SPEED;
    private replayTimer: ioBroker.Interval | null | undefined = null;
    private replayStepping = false;
    /** Mirror state (own ID) by object ID, if `mirrorStates` is on */
    private readonly mirrors = new Map<string, string>();
    /** Presence simulation, if enabled in the settings */
    private simulation: PresenceSimulation | null = null;
    /** The state that reports absence, and its last value (true: away) */
    private simTrigger = '';
    private triggerAway: boolean | null = null;
    /** From system.config, for the sunset */
    private coordinates: { latitude: number; longitude: number } | undefined;
    /** Statistics of the running hour, for the profiles of the anomaly detection */
    private readonly stats = new HourStats(hourFloor(Date.now()));
    private anomalies: AnomalyDetector | null = null;
    private anomalyTimer: ioBroker.Interval | null | undefined = null;
    /** The outdoor temperature found automatically (logged when it changes) */
    private outdoorId = '';

    private flushTimer: ioBroker.Interval | null | undefined = null;
    private keyframeTimer: ioBroker.Timeout | null | undefined = null;
    private retentionTimer: ioBroker.Timeout | null | undefined = null;
    private midnightTimer: ioBroker.Timeout | null | undefined = null;
    private reselectTimer: ioBroker.Timeout | null | undefined = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'recorder' });

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('objectChange', (id, obj) => this.onObjectChange(id, obj));
        this.on('message', obj => this.onMessage(obj));
        this.on('unload', callback => this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        this.retentionDays = RETENTION_DAYS.includes(Number(this.config.retentionDays))
            ? Number(this.config.retentionDays)
            : 30;
        const flushInterval = Math.max(1, Number(this.config.flushInterval) || 30);
        this.highRate = Number(this.config.highRate) > 0 ? Number(this.config.highRate) : DEFAULT_HIGH_RATE;
        this.filter.burstLimit =
            Number(this.config.burstLimit) >= 0 && this.config.burstLimit !== ('' as unknown)
                ? Number(this.config.burstLimit)
                : DEFAULT_BURST_LIMIT;
        this.roleRules = parseRoleRules(this.config.roleRules);
        this.filter.onThrottle = dp => this.onThrottle(dp);

        const systemConfig = await this.getForeignObjectAsync('system.config');
        this.lang = systemConfig?.common?.language || 'en';
        const latitude = Number(systemConfig?.common?.latitude);
        const longitude = Number(systemConfig?.common?.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude || longitude)) {
            this.coordinates = { latitude, longitude };
        }

        const dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.storage = new Storage(dataDir);
        try {
            this.storage.open();
        } catch (e) {
            this.log.error(`Cannot open the database in ${dataDir}: ${(e as Error).message}`);
            this.storage = null;
            return;
        }
        this.log.info(`Database in ${dataDir} (${DRIVER_NAME}), retention ${this.retentionDays} days`);
        this.rates = this.storage.loadRates();
        this.rateMeter = new RateMeter(Date.now());

        await this.loadObjects();
        await this.subscribeForeignObjectsAsync('*');
        await this.updateSelection();
        if (!this.storage) {
            // unloaded while starting
            return;
        }

        this.eventsToday = this.storage.countEvents(localMidnight(), Date.now() + 1);

        // A keyframe right away: values may have changed while the adapter was not running
        this.flush(this.createKeyframe());
        this.runRetention();

        this.flushTimer = this.setInterval(() => this.flush(), flushInterval * 1000);
        this.scheduleKeyframe();
        this.scheduleRetention();
        this.scheduleMidnight();
        await this.initReplay();
        await this.initTrigger();
        await this.initSimulation();
        await this.initAnomalies();
        await this.updateInfoStates(true);
    }

    // ---------------------------------------------------------------- selection

    /** Reads all objects the selection needs; afterward `onObjectChange` keeps them up to date */
    private async loadObjects(): Promise<void> {
        const objects: Record<string, ioBroker.Object> = {};
        for (const type of ['state', 'channel', 'device', 'folder'] as const) {
            Object.assign(objects, await this.getForeignObjectsAsync('*', type));
        }
        for (const pattern of ['enum.rooms.*', 'enum.functions.*']) {
            Object.assign(objects, await this.getForeignObjectsAsync(pattern, 'enum'));
        }
        this.objects = objects;
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (!this.storage || id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const old = this.objects[id];
        if (!isSelectionObject(id, obj)) {
            if (old) {
                // deleted, or not of a relevant type anymore
                delete this.objects[id];
                this.detection?.invalidate(id);
                this.scheduleReselect();
            }
            return;
        }
        this.objects[id] = obj!;
        // many adapters rewrite their objects on every start without changing them
        if (!old || old.type !== obj!.type || JSON.stringify(old.common) !== JSON.stringify(obj!.common)) {
            this.detection?.invalidate(id);
            this.scheduleReselect();
        }
    }

    /** Collects object changes for 30 seconds, then computes the selection again */
    private scheduleReselect(): void {
        this.reselectTimer ||= this.setTimeout(() => {
            this.reselectTimer = null;
            void this.updateSelection();
        }, RESELECT_DELAY);
    }

    private selectionConfig(override?: Partial<ioBroker.AdapterConfig>): SelectionConfig {
        const config = { ...this.config, ...override };
        return {
            categories: categoryModes(config),
            requireEnum: config.requireEnum === true || (config.requireEnum as unknown) === 'true',
            includePatterns: toPatternList(config.includePatterns),
            excludePatterns: toPatternList(config.excludePatterns),
            ownNamespace: this.namespace,
            lang: this.lang,
            rates: this.ratesByOid(),
            extremeRate: this.filter.burstLimit || undefined,
        };
    }

    /** Computes the selection; a request while it runs is executed once afterward */
    private async updateSelection(): Promise<void> {
        if (this.selectionRunning) {
            this.selectionPending = true;
            return;
        }
        this.selectionRunning = true;
        try {
            do {
                this.selectionPending = false;
                await this.applySelection();
            } while (this.selectionPending && this.storage);
        } catch (e) {
            this.log.error(`Cannot compute the selection: ${(e as Error).message}`);
        } finally {
            this.selectionRunning = false;
        }
    }

    /** Computes the selection and adapts subscriptions and master data to the difference */
    private async applySelection(): Promise<void> {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        this.detection ||= new DeviceDetection(this.namespace);
        const keys = Object.keys(this.objects).sort();
        // the first detection takes seconds on large installations: give other adapters a chance
        this.detected = await this.detection.update(
            this.objects,
            keys,
            () => new Promise<void>(resolve => setImmediate(resolve)),
        );
        if (!this.storage) {
            return;
        }
        const result = computeSelection(this.objects, this.selectionConfig(), this.detected, keys);

        const now = Date.now();
        const activeIds = new Set<number>();
        const added: string[] = [];
        this.recordedAliases.clear();
        storage.batchMeta(() => {
            for (const [id, selected] of result.selected) {
                const dp = storage.upsertDp(selected, now);
                activeIds.add(dp.id);
                if (!this.dps.has(id)) {
                    added.push(id);
                }
                const previous = this.dps.get(id);
                if (previous && previous.cls !== dp.cls) {
                    // e.g. classified as high-frequency: start anew with the new class
                    this.filter.remove(dp.id);
                    this.aggregator.remove(dp.id);
                }
                this.dps.set(id, dp);
                this.reasons.set(id, selected.reason);
                this.filters.set(dp.id, this.filterOf(id, dp));
                const obj = this.objects[id];
                const target = obj?.type === 'state' ? aliasTarget(obj) : null;
                if (target) {
                    this.recordedAliases.set(target, id);
                }
            }
        });
        const removed = [...this.dps.keys()].filter(id => !result.selected.has(id));
        for (const id of removed) {
            const dp = this.dps.get(id);
            if (dp) {
                this.cache.delete(dp.id);
                this.aggregator.remove(dp.id);
                this.filter.remove(dp.id);
                this.filters.delete(dp.id);
                this.stats.remove(dp.id);
            }
            this.dps.delete(id);
            this.reasons.delete(id);
        }
        storage.deactivateAllExcept(activeIds);

        // the trigger of the presence simulation stays subscribed
        const unsubscribe = removed.filter(id => id !== this.simTrigger);
        if (unsubscribe.length) {
            await this.unsubscribeForeignStatesAsync(unsubscribe);
        }
        if (added.length) {
            await this.subscribeForeignStatesAsync(added);
            await this.readInitialValues(added);
            if (this.flushTimer) {
                // added while running: a keyframe must hold every datapoint, so that a snapshot finds them
                this.flush(this.createKeyframe());
            }
        }
        try {
            await this.syncMirrors();
        } catch (e) {
            this.log.error(`Cannot update the mirror states: ${(e as Error).message}`);
        }

        if (!this.dps.size) {
            this.log.warn('No states selected for recording. Check the categories and rules in the instance settings.');
        } else {
            const estimate = estimateSize([...result.selected.values()], new Map(), this.retentionDays);
            this.log.info(
                `Recording ${this.dps.size} states (${added.length} added, ${removed.length} removed, ` +
                    `${result.examined} examined in ${result.durationMs} ms), ` +
                    `estimated ${estimate.mbPerMonth} MB per month`,
            );
        }
        await this.setStateAsync('info.recordedCount', this.dps.size, true);
    }

    /** Fills the value cache with the current values, so that the next keyframe is complete */
    private async readInitialValues(ids: string[]): Promise<void> {
        // in chunks, so that a single request does not get too large
        for (let i = 0; i < ids.length; i += 500) {
            const states = await this.getForeignStatesAsync(ids.slice(i, i + 500));
            for (const [id, state] of Object.entries(states)) {
                const dp = this.dps.get(id);
                if (dp && state && !this.cache.has(dp.id)) {
                    const stored = encodeValue(state.val, dp.type);
                    this.cache.set(dp.id, { ...stored, ack: !!state.ack });
                    const ts = state.ts || Date.now();
                    this.stats.init(dp.id, stored.val, ts, state.lc || ts);
                    // the value is in the next keyframe: the dead band starts from it
                    this.filter.setBase(dp.id, stored.val, state.ts || Date.now());
                }
            }
        }
    }

    // ---------------------------------------------------------------- messages

    private onMessage(obj: ioBroker.Message): void {
        if (!obj?.command) {
            return;
        }
        const respond = (response: unknown): void => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response as ioBroker.MessagePayload, obj.callback);
            }
        };
        switch (obj.command) {
            case 'help':
                // what the instance answers, for an AI agent
                respond({ help: HELP });
                break;

            case 'getSelection':
                respond(this.getSelectionInfo());
                break;

            case 'previewSelection':
                respond(this.previewSelection(obj.message as Partial<ioBroker.AdapterConfig> | undefined));
                break;

            case 'getHighFrequency':
                respond(this.highFrequencyInfo());
                break;

            case 'recalculate':
                void this.updateSelection().then(() => respond({ result: `${this.dps.size} states` }));
                break;

            // walk into the past
            case 'getSnapshot':
                respond(
                    this.walk(storage => readSnapshot(storage, obj.message as SnapshotRequest, this.pendingData())),
                );
                break;

            case 'getEvents':
                respond(this.walk(storage => readEventList(storage, obj.message as EventsRequest, this.pendingData())));
                break;

            case 'getTimeline':
                respond(this.walk(storage => readTimeline(storage, obj.message as TimelineRequest)));
                break;

            // presence simulation
            case 'getSimulationPlan':
                respond(
                    this.walk(storage =>
                        this.simulationPlan(storage, obj.message as Partial<ioBroker.AdapterConfig> | null),
                    ),
                );
                break;

            // anomaly detection
            case 'getAnomalies':
                respond(this.walk(storage => this.getAnomalies(storage, obj.message as Record<string, never> | null)));
                break;

            case 'getProfile': {
                const id = (obj.message as { id?: string } | null)?.id;
                const dp = id ? (this.dps.get(id) ?? this.storage?.getDp(id)) : undefined;
                respond(
                    !dp || !this.anomalies
                        ? { error: `${id} is not recorded` }
                        : this.walk(() => this.anomalies!.profileOf(dp)),
                );
                break;
            }

            case 'ackAnomaly': {
                const id = Number((obj.message as { id?: number } | null)?.id);
                if (!this.anomalies) {
                    respond({ error: 'The instance is not ready yet' });
                } else {
                    void this.anomalies
                        .ack(Number.isFinite(id) && id > 0 ? id : null)
                        .then(count => respond({ count }));
                }
                break;
            }

            case 'getAnomalyInfo':
                respond({ text: this.anomalies?.renderInfo() ?? '' });
                break;

            // the commands of history, sql and influxdb
            case 'getHistory':
                this.handleGetHistory(obj);
                break;

            case 'features':
                // no update, delete or storeState: the recorder keeps what happened
                respond({ supportedFeatures: [] });
                break;

            case 'getEnabledDPs':
                respond(this.getEnabledDps());
                break;

            case 'enableHistory':
                void this.setCustomMode(obj, 'always').then(respond);
                break;

            case 'disableHistory':
                void this.setCustomMode(obj, 'exclude').then(respond);
                break;

            default:
                respond({ error: `Unknown command: ${obj.command}`, commands: COMMANDS });
        }
    }

    /** `getHistory` with the options of history, sql and influxdb, aggregated by `@iobroker/aggregate` */
    private handleGetHistory(msg: ioBroker.Message): void {
        const startTime = Date.now();
        const request = parseHistoryRequest(msg.message, startTime);
        if ('error' in request) {
            if (msg.callback) {
                this.sendTo(msg.from, msg.command, { result: [], step: null, error: request.error }, msg.callback);
            }
            return;
        }
        const { id, options } = request;
        const storage = this.storage;
        if (!storage) {
            sendResponse(this, msg, id, options, 'The instance is not ready yet', startTime);
            return;
        }
        // also datapoints that are not recorded anymore, as long as their data is kept
        const recordedId = this.dps.has(id) ? id : this.recordedAliases.get(id) || id;
        const dp = this.dps.get(recordedId) || storage.getDp(recordedId);
        let data: IobDataEntry[] = [];
        if (dp) {
            try {
                data = readHistory(storage, dp, options, {
                    events: this.buffer,
                    aggregates: this.aggregator.pending(dp.id),
                });
            } catch (e) {
                sendResponse(this, msg, id, options, `Cannot read the history of ${id}: ${String(e)}`, startTime);
                return;
            }
        }
        sendResponse(this, msg, id, options, data, startTime);
    }

    /** Answer of `getEnabledDPs`: the recorded datapoints, like the enabled ones of history */
    private getEnabledDps(): Record<string, { enabled: true; category: string | null; cls: string; reason: string }> {
        const result: Record<string, { enabled: true; category: string | null; cls: string; reason: string }> = {};
        for (const [id, dp] of this.dps) {
            result[id] = {
                enabled: true,
                category: dp.category,
                cls: CLASS_NAMES[dp.cls] || 'discrete',
                reason: this.reasons.get(id) || '',
            };
        }
        return result;
    }

    /**
     * `enableHistory` and `disableHistory`: as the states are selected automatically, "disable"
     * must exclude the state explicitly. The selection follows within `RESELECT_DELAY`.
     */
    private async setCustomMode(
        msg: ioBroker.Message,
        mode: 'always' | 'exclude',
    ): Promise<{ success: true } | { error: string }> {
        const message = msg.message as { id?: unknown; options?: unknown } | null;
        const id = message?.id;
        if (typeof id !== 'string' || !id) {
            return { error: 'Invalid call' };
        }
        const options =
            mode === 'always' && message?.options && typeof message.options === 'object' ? message.options : {};
        try {
            await this.extendForeignObjectAsync(id, {
                common: { custom: { [this.namespace]: { ...options, enabled: true, mode } } },
            });
            return { success: true };
        } catch (e) {
            this.log.error(`${msg.command} ${id}: ${String(e)}`);
            return { error: String(e) };
        }
    }

    private getSelectionInfo(): SelectionInfo[] {
        return [...this.dps.values()].map(dp => ({
            id: dp.oid,
            name: dp.name,
            room: dp.room,
            func: dp.func,
            category: dp.category,
            devType: dp.devType,
            cls: CLASS_NAMES[dp.cls] || 'discrete',
            reason: this.reasons.get(dp.oid) || '',
        }));
    }

    /**
     * Computes the selection for the configuration in the admin (not yet saved) without applying it.
     * Answers in the format of the `textSendTo` control.
     */
    private previewSelection(override: Partial<ioBroker.AdapterConfig> | undefined): {
        text: string;
        count?: number;
        mbPerMonth?: number;
    } {
        const storage = this.storage;
        if (!storage || !this.detected) {
            return { text: 'The instance is not ready yet' };
        }
        const retentionDays = RETENTION_DAYS.includes(Number(override?.retentionDays))
            ? Number(override?.retentionDays)
            : this.retentionDays;
        const result: SelectionResult = computeSelection(
            this.objects,
            this.selectionConfig(override && typeof override === 'object' ? override : undefined),
            // the detection of the last selection run; object changes since then follow within 30 s
            this.detected,
        );

        // measured rates of the last 24 hours
        const now = Date.now();
        const changesPerDay = new Map<string, number>();
        for (const [id, count] of storage.countEventsPerDp(now - DAY, now)) {
            const dp = storage.getDpById(id);
            if (dp) {
                changesPerDay.set(dp.oid, count);
            }
        }
        const estimate = estimateSize([...result.selected.values()], changesPerDay, retentionDays);
        this.log.debug(`Preview: ${summaryText(estimate, retentionDays, 'en')}`);
        return {
            text: renderPreview(result, estimate, retentionDays, this.lang),
            count: estimate.count,
            mbPerMonth: estimate.mbPerMonth,
        };
    }

    // ---------------------------------------------------------------- walk into the past

    /** Runs a reading command; errors become `{ error }` */
    private walk<T>(fn: (storage: Storage) => T): T | { error: string } {
        if (!this.storage) {
            return { error: 'The instance is not ready yet' };
        }
        try {
            return fn(this.storage);
        } catch (e) {
            this.log.error(`Cannot read the recording: ${(e as Error).message}`);
            return { error: String(e) };
        }
    }

    /** Data that is not written yet; the readers include it */
    private pendingData(): PendingData {
        return { events: this.buffer, aggregates: this.aggregator.pendingAll() };
    }

    /** Restores time and speed of the replay; a running replay does not survive a restart */
    private async initReplay(): Promise<void> {
        const time = await this.getStateAsync('replay.time');
        const speed = await this.getStateAsync('replay.speed');
        this.replayTime = Number(time?.val) || 0;
        this.replaySpeed = this.toReplaySpeed(speed?.val) ?? DEFAULT_REPLAY_SPEED;
        await this.setStateAsync('replay.active', false, true);
        await this.subscribeStatesAsync('replay.*');
    }

    private toReplaySpeed(value: unknown): number | undefined {
        const speed = Number(value);
        if (!Number.isFinite(speed) || speed <= 0) {
            return undefined;
        }
        return Math.min(MAX_REPLAY_SPEED, Math.max(MIN_REPLAY_SPEED, speed));
    }

    /** A replay time within the recorded period */
    private clampReplayTime(ts: number): number {
        const now = Date.now();
        const oldest = this.storage?.oldestTs() ?? now;
        return Math.max(oldest, Math.min(ts, now));
    }

    /** Commands to `replay.active`, `replay.time` and `replay.speed` */
    private async onReplayCommand(id: string, state: ioBroker.State): Promise<void> {
        try {
            switch (id) {
                case 'replay.time': {
                    const ts = toTimestamp(state.val);
                    if (ts === undefined) {
                        this.log.warn(`Invalid replay time: ${String(state.val)}`);
                        await this.setStateAsync('replay.time', this.replayTime, true);
                        break;
                    }
                    this.replayTime = this.clampReplayTime(ts);
                    await this.setStateAsync('replay.time', this.replayTime, true);
                    // a jump: the mirrors show the state at the new time
                    await this.mirrorSnapshot(this.replayTime);
                    break;
                }

                case 'replay.speed':
                    this.replaySpeed = this.toReplaySpeed(state.val) ?? this.replaySpeed;
                    await this.setStateAsync('replay.speed', this.replaySpeed, true);
                    break;

                case 'replay.active':
                    if (state.val === true || state.val === 'true' || state.val === 1) {
                        await this.startReplay();
                    } else {
                        await this.stopReplay();
                    }
                    break;
            }
        } catch (e) {
            this.log.error(`Replay: ${(e as Error).message}`);
        }
    }

    private async startReplay(): Promise<void> {
        if (!this.storage) {
            return;
        }
        const now = Date.now();
        if (!this.replayTime || this.replayTime >= now - REPLAY_TICK) {
            // no time chosen, or at the present: one day back
            this.replayTime = now - DAY;
        }
        this.replayTime = this.clampReplayTime(this.replayTime);
        await this.mirrorSnapshot(this.replayTime);
        if (this.replayTimer) {
            this.clearInterval(this.replayTimer);
        }
        this.replayTimer = this.setInterval(() => void this.replayStep(), REPLAY_TICK);
        await this.setStateAsync('replay.time', this.replayTime, true);
        await this.setStateAsync('replay.active', true, true);
        this.log.info(
            `Replay from ${new Date(this.replayTime).toISOString()} at ${this.replaySpeed}x${
                this.mirrors.size ? `, ${this.mirrors.size} mirror states` : ', without mirror states'
            }`,
        );
    }

    private async stopReplay(): Promise<void> {
        if (this.replayTimer) {
            this.clearInterval(this.replayTimer);
            this.replayTimer = null;
        }
        await this.setStateAsync('replay.active', false, true);
    }

    /** One step of the replay: only the changes since the last step are written to the mirrors */
    private async replayStep(): Promise<void> {
        if (this.replayStepping || !this.storage || !this.replayTimer) {
            return;
        }
        this.replayStepping = true;
        try {
            const now = Date.now();
            const from = this.replayTime;
            const to = Math.min(from + this.replaySpeed * REPLAY_TICK, now);
            if (this.mirrors.size) {
                await this.writeMirrors(readChanges(this.storage, from, to, this.pendingData()), to);
            }
            this.replayTime = to;
            await this.setStateAsync('replay.time', to, true);
            if (to >= now) {
                this.log.info('The replay reached the present');
                await this.stopReplay();
            }
        } catch (e) {
            this.log.error(`Replay: ${(e as Error).message}`);
        } finally {
            this.replayStepping = false;
        }
    }

    /** Writes the state at `ts` to all mirror states */
    private async mirrorSnapshot(ts: number): Promise<void> {
        if (this.storage && this.mirrors.size) {
            await this.writeMirrors(readSnapshot(this.storage, { ts }, this.pendingData()).states, ts);
        }
    }

    private async writeMirrors(entries: SnapshotEntry[], fallbackTs: number): Promise<void> {
        for (const entry of entries) {
            const mirror = this.mirrors.get(entry.id);
            if (!mirror) {
                continue;
            }
            const val = entry.val !== null && typeof entry.val === 'object' ? JSON.stringify(entry.val) : entry.val;
            // the time of the change in the past, so that "last changed" in a vis view is right
            await this.setStateAsync(mirror, { val, ack: true, ts: entry.lc ?? fallbackTs });
        }
    }

    /** `recorder.0.mirror.<object ID with _>` */
    private mirrorIdOf(oid: string): string {
        return `mirror.${oid.replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_')}`;
    }

    /** The mirror object of a recorded datapoint: like the original, but read-only */
    private mirrorObject(oid: string): ioBroker.SettableStateObject {
        const original = this.objects[oid]?.common as Partial<ioBroker.StateCommon> | undefined;
        const common: ioBroker.StateCommon = {
            name: original?.name ?? this.dps.get(oid)?.name ?? oid,
            type: original?.type ?? 'mixed',
            role: original?.role || 'state',
            read: true,
            write: false,
        };
        if (original?.unit) {
            common.unit = original.unit;
        }
        if (original?.states) {
            common.states = original.states;
        }
        if (typeof original?.min === 'number') {
            common.min = original.min;
        }
        if (typeof original?.max === 'number') {
            common.max = original.max;
        }
        return { type: 'state', common, native: { id: oid } };
    }

    /**
     * With `mirrorStates` a read-only copy of every recorded datapoint under `mirror.*`, which the
     * replay writes: a vis view on the mirrors becomes a time machine. Without it, the mirrors are
     * deleted.
     */
    private async syncMirrors(): Promise<void> {
        const enabled = this.config.mirrorStates === true || (this.config.mirrorStates as unknown) === 'true';
        const prefix = `${this.namespace}.mirror.`;
        const view = await this.getObjectViewAsync('system', 'state', {
            startkey: prefix,
            endkey: `${prefix}香`,
        });
        const existing = new Set(view.rows.map(row => row.id));
        this.mirrors.clear();
        if (!enabled) {
            if (existing.size || (await this.getObjectAsync('mirror'))) {
                await this.delObjectAsync('mirror', { recursive: true });
                this.log.info('Deleted the mirror states');
            }
            return;
        }
        await this.setObjectNotExistsAsync('mirror', {
            type: 'folder',
            common: { name: 'Mirror states for the replay' },
            native: {},
        });
        const wanted = new Set<string>();
        let created = 0;
        for (const oid of this.dps.keys()) {
            const mirror = this.mirrorIdOf(oid);
            this.mirrors.set(oid, mirror);
            wanted.add(`${this.namespace}.${mirror}`);
            if (!existing.has(`${this.namespace}.${mirror}`)) {
                await this.setObjectAsync(mirror, this.mirrorObject(oid));
                created++;
            }
        }
        let deleted = 0;
        for (const id of existing) {
            if (!wanted.has(id)) {
                await this.delForeignObjectAsync(id);
                deleted++;
            }
        }
        if (created || deleted) {
            this.log.info(`Mirror states: ${created} created, ${deleted} deleted`);
        }
    }

    // ---------------------------------------------------------------- presence simulation

    private simulationEnabled(): boolean {
        return toBool(this.config.simulation, false);
    }

    private simulationSettings(override?: Partial<ioBroker.AdapterConfig> | null): SimulatorSettings {
        const config = { ...this.config, ...override };
        return {
            weeks: toInt(config.simWeeks, 1, 12, 4),
            jitter: toInt(config.simJitter, 0, 60, 15),
            sunset: toBool(config.simSunset, true),
            media: toBool(config.simMedia, false),
            scripts: toBool(config.simScripts, false),
            dryRun: toBool(config.simDryRun, false),
            latitude: this.coordinates?.latitude,
            longitude: this.coordinates?.longitude,
        };
    }

    private simulationHost(): SimulationHost {
        return {
            log: this.log,
            ownFrom: `system.adapter.${this.namespace}`,
            storage: () => this.storage,
            datapoints: () => [...this.dps.values()],
            common: oid => this.objects[oid]?.common as Partial<ioBroker.StateCommon> | undefined,
            getState: oid => this.getForeignStateAsync(oid),
            setState: async (oid, val) => {
                // from = this instance, so that it is never recorded as an action of a person
                await this.setForeignStateAsync(oid, { val, ack: false, c: 'presence simulation' });
            },
            report: status => this.reportSimulation(status),
            startTimer: (fn, ms) => this.setTimeout(fn, ms),
            stopTimer: timer => this.clearTimeout(timer as ioBroker.Timeout),
            now: () => Date.now(),
            random: () => Math.random(),
        };
    }

    /**
     * Starts the simulation if the trigger reports absence. Without a trigger, a simulation that
     * was switched on manually continues after a restart; with a trigger, the trigger decides.
     */
    private async initSimulation(): Promise<void> {
        await this.subscribeStatesAsync('simulation.enabled');
        const enabled = await this.getStateAsync('simulation.enabled');
        const simulation = new PresenceSimulation(this.simulationHost(), this.simulationSettings(), this.lang);
        if (!this.simulationEnabled()) {
            if (enabled?.val === true) {
                // switched off in the settings while it ran: the defined end state
                await simulation.finishAfterRestart('disabled in the settings');
            }
            if (enabled?.val !== false) {
                await this.setStateAsync('simulation.enabled', false, true);
            }
            return;
        }
        this.simulation = simulation;
        if (this.simTrigger) {
            if (this.triggerAway) {
                await simulation.start(`${this.simTrigger} reports absence`, enabled?.val === true);
            } else if (enabled?.val === true) {
                await simulation.finishAfterRestart(`${this.simTrigger} reports presence`);
            }
        } else if (enabled?.val === true) {
            await simulation.start('switched on before the restart', true);
        }
        if (!simulation.running) {
            await this.reportSimulation({ active: false, sourceDay: '', nextAction: '', lastAction: '' });
        }
        await this.setStateAsync('simulation.enabled', simulation.running, true);
    }

    /**
     * The absence state: it starts and stops the simulation; while away, the anomaly detection
     * reports every motion and opening.
     */
    private async initTrigger(): Promise<void> {
        const trigger = String(this.config.simTrigger || '').trim();
        if (!trigger || (!this.simulationEnabled() && !toBool(this.config.anomalies, true))) {
            return;
        }
        this.simTrigger = trigger;
        await this.subscribeForeignStatesAsync(trigger);
        const state = await this.getForeignStateAsync(trigger);
        this.triggerAway = state ? triggerMeansAway(state.val, toBool(this.config.simTriggerInvert, false)) : null;
    }

    /** The trigger changed: absence starts the simulation, presence stops it at once */
    private onTrigger(state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }
        const away = triggerMeansAway(state.val, toBool(this.config.simTriggerInvert, false));
        if (away === this.triggerAway) {
            return;
        }
        this.triggerAway = away;
        const simulation = this.simulation;
        if (!simulation) {
            return;
        }
        // stop() clears its timer synchronously, before the first await
        const change = away
            ? simulation.start(`${this.simTrigger} reports absence`)
            : simulation.stop(`${this.simTrigger} reports presence`);
        void change
            .then(() => this.setStateAsync('simulation.enabled', simulation.running, true))
            .catch(e => this.log.error(`Presence simulation: ${(e as Error).message}`));
    }

    /** `simulation.enabled` written by a person or a script */
    private async onSimulationCommand(state: ioBroker.State): Promise<void> {
        const on = state.val === true || state.val === 'true' || state.val === 1;
        const simulation = this.simulation;
        if (!simulation) {
            if (on) {
                this.log.warn('The presence simulation is not enabled in the instance settings');
            }
            await this.setStateAsync('simulation.enabled', false, true);
            return;
        }
        if (on) {
            await simulation.start('switched on');
        } else {
            await simulation.stop('switched off');
        }
        await this.setStateAsync('simulation.enabled', simulation.running, true);
    }

    private async reportSimulation(status: SimulationStatus): Promise<void> {
        await this.setStateChangedAsync('simulation.sourceDay', status.sourceDay, true);
        await this.setStateChangedAsync('simulation.nextAction', status.nextAction, true);
        await this.setStateChangedAsync('simulation.lastAction', status.lastAction, true);
    }

    /**
     * `getSimulationPlan`: the plan of the current simulated day; while the simulation runs with the
     * same settings the running plan, else a new one (random choices differ each time).
     */
    private simulationPlan(
        storage: Storage,
        override: Partial<ioBroker.AdapterConfig> | null,
    ): { text: string; start: number; source: number | null; actions: unknown[] } {
        const settings = this.simulationSettings(override);
        const now = Date.now();
        const dps = switchableDps(
            [...this.dps.values()],
            oid => this.objects[oid]?.common as Partial<ioBroker.StateCommon> | undefined,
            settings.media,
        );
        const running = this.simulation?.running ? this.simulation.currentPlan : null;
        const same =
            running &&
            ['weeks', 'jitter', 'sunset', 'media', 'scripts'].every(
                key =>
                    settings[key as keyof SimulatorSettings] ===
                    this.simulation!.settings[key as keyof SimulatorSettings],
            );
        const plan =
            same && running ? running : planSimulatedDay(storage, dps, windowStart(now), settings, Math.random);
        return {
            text: renderPlan(plan, storage, dps.length, settings.media, now, this.lang),
            start: plan.start,
            source: plan.source,
            actions: plan.actions.map(action => {
                const dp = storage.getDpById(action.dp);
                return {
                    ts: action.ts,
                    sourceTs: action.sourceTs,
                    id: dp?.oid,
                    name: dp?.name,
                    room: dp?.room,
                    val: dp?.type === 'boolean' ? action.val !== 0 : action.val,
                    kind: action.kind,
                };
            }),
        };
    }

    // ---------------------------------------------------------------- anomaly detection

    private anomalySettings(): AnomalySettings {
        const c = this.config;
        const d = DEFAULT_ANOMALY_SETTINGS;
        return {
            value: toBool(c.anoValue, d.value),
            rare: toBool(c.anoRare, d.rare),
            silent: toBool(c.anoSilent, d.silent),
            long: toBool(c.anoLong, d.long),
            cold: toBool(c.anoCold, d.cold),
            racing: toBool(c.anoRacing, d.racing),
            zScore: toFloat(c.anoZ, 1.5, 10, d.zScore),
            valueMinutes: toInt(c.anoValueMinutes, 0, 1440, d.valueMinutes),
            rareShare: toFloat(c.anoRareShare, 0, 50, d.rareShare * 100) / 100,
            silentHours: toFloat(c.anoSilentHours, 1, 168, d.silentHours),
            silentFactor: d.silentFactor,
            longFactor: toFloat(c.anoLongFactor, 1, 20, d.longFactor),
            coldTemp: toFloat(c.anoColdTemp, -30, 30, d.coldTemp),
            coldMinutes: toInt(c.anoColdMinutes, 0, 1440, d.coldMinutes),
            racingFactor: toFloat(c.anoRacingFactor, 2, 1000, d.racingFactor),
            quietHours: toFloat(c.anoQuietHours, 0, 168, d.quietHours),
            learnDays: toInt(c.anoLearnDays, 7, 56, d.learnDays),
        };
    }

    private detectorHost(): DetectorHost {
        return {
            log: this.log,
            storage: () => this.storage,
            datapoints: () => [...this.dps.values()],
            value: dp => this.cache.get(dp)?.val ?? null,
            away: () => (this.simTrigger ? this.triggerAway : null),
            outdoorTemperature: () => this.outdoorTemperature(),
            notify: (_anomaly, text) => this.notifyAnomaly(text),
            report: open => this.reportAnomalies(open),
            now: () => Date.now(),
            pause: () => new Promise<void>(resolve => setImmediate(resolve)),
        };
    }

    /** Statistics and profiles always; the rules only if enabled */
    private async initAnomalies(): Promise<void> {
        const detector = new AnomalyDetector(
            this.detectorHost(),
            this.stats,
            this.anomalySettings(),
            toBool(this.config.anomalies, true),
            this.lang,
        );
        this.anomalies = detector;
        await this.subscribeStatesAsync('anomaly.ack');
        await detector.start();
        this.anomalyTimer = this.setInterval(() => {
            detector.check().catch(e => this.log.error(`Anomaly detection: ${(e as Error).message}`));
        }, MINUTE);
        // the statistics before the first live hour from the recording, and the profiles: in the background
        detector
            .prepare(this.stats.start)
            .catch(e => this.log.error(`Anomaly detection: cannot compute the statistics: ${(e as Error).message}`));
    }

    /** The outdoor temperature: the configured state, or else a recorded weather temperature */
    private async outdoorTemperature(): Promise<{ val: number; name: string } | null> {
        const configured = String(this.config.anoOutdoor || '').trim();
        let oid = configured;
        if (!oid) {
            const found = [...this.dps.values()]
                .filter(
                    dp =>
                        dp.category === 'weather' &&
                        /^value\.temperature/.test(dp.role || '') &&
                        !/forecast|tomorrow|max|min|feel|dew|day\d/i.test(`${dp.oid} ${dp.role}`),
                )
                .sort((a, b) => a.oid.localeCompare(b.oid));
            oid = found[0]?.oid ?? '';
            if (oid !== this.outdoorId) {
                this.outdoorId = oid;
                if (oid) {
                    this.log.info(`Anomaly detection: outdoor temperature from ${oid}`);
                }
            }
        }
        if (!oid) {
            return null;
        }
        const dp = this.dps.get(oid);
        let val = dp ? (this.cache.get(dp.id)?.val ?? null) : null;
        if (val === null && configured) {
            const state = await this.getForeignStateAsync(oid);
            const n = typeof state?.val === 'number' ? state.val : parseFloat(String(state?.val));
            val = Number.isFinite(n) ? n : null;
        }
        return val === null ? null : { val, name: dp?.name || oid };
    }

    /** A new anomaly: ioBroker notification (forwarded e.g. by notification-manager) and/or a messenger */
    private async notifyAnomaly(text: string): Promise<void> {
        if (toBool(this.config.anoNotify, true)) {
            await this.registerNotification('recorder', 'anomaly', text);
        }
        const instance = String(this.config.anoInstance || '').trim();
        if (instance) {
            // telegram, signal, whatsapp: text; pushover: message, title; email: text, subject
            this.sendTo(instance, 'send', { text, message: text, title: 'ioBroker', subject: 'ioBroker' });
        }
    }

    private async reportAnomalies(open: AnomalyRecord[]): Promise<void> {
        await this.setStateChangedAsync('anomaly.active', open.length > 0, true);
        await this.setStateChangedAsync('anomaly.count', open.length, true);
        await this.setStateChangedAsync('anomaly.list', JSON.stringify(this.anomalyEntries(open.slice(0, 50))), true);
        await this.setStateChangedAsync('anomaly.last', open[0]?.text ?? '', true);
    }

    /** Anomalies with object ID, name and room */
    private anomalyEntries(anomalies: AnomalyRecord[]): {
        id: number;
        ts: number;
        endTs: number | null;
        ackTs: number | null;
        rule: string;
        oid: string | null;
        name: string | null;
        room: string | null;
        val: number | null;
        text: string;
    }[] {
        return anomalies.map(a => {
            const dp = this.storage?.getDpById(a.dp);
            return {
                id: a.id,
                ts: a.ts,
                endTs: a.endTs,
                ackTs: a.ackTs,
                rule: a.rule,
                oid: dp?.oid ?? null,
                name: dp?.name ?? null,
                room: dp?.room ?? null,
                val: a.val,
                text: a.text,
            };
        });
    }

    /** `getAnomalies`: the anomalies in a time range, or only the open ones */
    private getAnomalies(
        storage: Storage,
        message: { start?: number | string; end?: number | string; open?: boolean; limit?: number } | null,
    ): { anomalies: ReturnType<RecorderAdapter['anomalyEntries']> } {
        const now = Date.now();
        const start = toTimestamp(message?.start) ?? now - 7 * DAY;
        const end = toTimestamp(message?.end) ?? now + 1;
        const limit = toInt(message?.limit, 1, 10_000, 1000);
        return {
            anomalies: this.anomalyEntries(storage.readAnomalies(start, end, message?.open ? 'open' : 'all', limit)),
        };
    }

    // ---------------------------------------------------------------- recording

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (this.simTrigger && id === this.simTrigger) {
            // the trigger may be recorded as well
            this.onTrigger(state);
        }
        if (id.startsWith(`${this.namespace}.`)) {
            // the own namespace is never recorded; only the commands of replay and simulation are subscribed
            if (state && !state.ack) {
                const own = id.substring(this.namespace.length + 1);
                if (own === 'simulation.enabled') {
                    void this.onSimulationCommand(state).catch(e =>
                        this.log.error(`Presence simulation: ${(e as Error).message}`),
                    );
                } else if (own === 'anomaly.ack') {
                    void this.anomalies
                        ?.ack(null)
                        .then(() => this.setStateAsync('anomaly.ack', state.val, true))
                        .catch(e => this.log.error(`Anomaly detection: ${(e as Error).message}`));
                } else {
                    void this.onReplayCommand(own, state);
                }
            }
            return;
        }
        const storage = this.storage;
        const dp = this.dps.get(id);
        if (!storage || !dp || !state) {
            return;
        }
        const now = Date.now();
        const ts = state.ts || now;
        if (ts < now - this.retentionDays * DAY) {
            // an adapter set a timestamp from the past, older than anything we keep
            return;
        }
        const stored = encodeValue(state.val, dp.type);
        const ack = !!state.ack;

        const previous = this.cache.get(dp.id);
        const changed = !previous || !sameValue(previous, stored);
        if (changed) {
            this.rateMeter.count(dp.id);
        }
        this.stats.update(dp.id, ts, stored.val, changed);
        // the lights of a running presence simulation are no rare activity
        if (changed && this.anomalies && !(dp.category === 'light' && this.simulation?.running)) {
            this.anomalies
                .onChange(dp, stored.val, isActive(previous?.val))
                .catch(e => this.log.error(`Anomaly detection: ${(e as Error).message}`));
        }

        if (dp.cls === DpClass.Aggregated) {
            // every sample counts for the mean, also unchanged ones
            if (stored.val !== null) {
                this.aggregator.add(dp.id, ts, stored.val);
            }
            this.cache.set(dp.id, { ...stored, ack });
            return;
        }
        if (!changed && previous.ack === ack) {
            // only the timestamp was updated
            return;
        }
        this.cache.set(dp.id, { ...stored, ack });
        if (dp.cls === DpClass.Discarded) {
            return;
        }
        const event = this.filter.offer(
            {
                ts,
                dp: dp.id,
                val: stored.val,
                sval: stored.sval,
                ack,
                src: storage.getSourceId(state.from, state.user, classifySource(state.from)),
            },
            this.filters.get(dp.id) || { rule: null, burst: true },
        );
        if (event) {
            this.record(event);
            if (this.buffer.length >= MAX_BATCH) {
                this.flush();
            }
        }
    }

    /** Puts an event into the buffer */
    private record(event: RecordedEvent): void {
        this.buffer.push(event);
        this.eventsToday++;
    }

    /** The state of all recorded datapoints, from the value cache */
    private createKeyframe(): Keyframe {
        const rows: Keyframe['rows'] = [];
        for (const dp of this.dps.values()) {
            const value = this.cache.get(dp.id);
            if (value) {
                rows.push({ dp: dp.id, val: value.val, sval: value.sval });
            }
        }
        return { ts: Date.now(), rows };
    }

    /**
     * Writes the buffer, the finished 5 minute aggregates and a keyframe in one transaction.
     *
     * @param keyframe keyframe to write with this batch
     * @param final on unload: also write the running aggregates and do not update states
     */
    private flush(keyframe?: Keyframe, final = false): void {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        const now = Date.now();
        // changes held back by the filter whose time has come; on unload all, so the last state is known
        const held = final ? this.filter.takeHeld() : this.filter.due(now, dp => this.filters.get(dp));
        for (const event of held) {
            this.record(event);
        }
        const aggregates = final ? this.aggregator.takeAll() : this.aggregator.takeClosed(now);
        if (!this.buffer.length && !aggregates.length && !keyframe?.rows.length) {
            return;
        }
        const events = this.buffer;
        this.buffer = [];
        try {
            storage.write(events, keyframe, aggregates);
        } catch (e) {
            this.log.error(`Cannot write ${events.length} events: ${(e as Error).message}`);
            // keep them for the next attempt, but do not grow without limit
            this.aggregator.restore(aggregates);
            this.buffer = events.concat(this.buffer);
            if (this.buffer.length > MAX_BUFFER) {
                const drop = this.buffer.length - MAX_BUFFER;
                this.buffer.splice(0, drop);
                this.droppedEvents += drop;
                this.log.error(`Dropped ${drop} events (${this.droppedEvents} in total), the database is not writable`);
            }
            return;
        }
        if (!final) {
            void this.updateInfoStates();
        }
    }

    private async updateInfoStates(force = false): Promise<void> {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        const dbSize = Math.round((storage.sizeBytes() / 1_048_576) * 100) / 100;
        if (force || dbSize !== this.lastDbSize) {
            this.lastDbSize = dbSize;
            await this.setStateAsync('info.dbSize', dbSize, true);
        }
        if (force || this.eventsToday !== this.lastEventsToday) {
            this.lastEventsToday = this.eventsToday;
            await this.setStateAsync('info.eventsToday', this.eventsToday, true);
        }
    }

    // ---------------------------------------------------------------- frequency filter

    /** The filter of a recorded datapoint, from its class, role and per-state setting */
    private filterOf(id: string, dp: DpInfo): DpFilter {
        const common = this.objects[id]?.common as ioBroker.StateCommon | undefined;
        const custom = common?.custom?.[this.namespace] as RecorderCustom | undefined;
        // "every change" is the positive list: no burst limit either
        const burst = !(custom?.enabled && custom.filter === 'all');
        if (dp.cls !== DpClass.Continuous) {
            return { rule: null, burst };
        }
        return { rule: filterRuleFor(common || {}, this.roleRules), burst };
    }

    /** The high-frequency datapoints by object ID, for the selection */
    private ratesByOid(): Map<string, RateInfo> {
        const result = new Map<string, RateInfo>();
        for (const [dpId, rate] of this.rates) {
            if (rate.high) {
                const oid = this.storage?.getDpById(dpId)?.oid;
                if (oid) {
                    result.set(oid, rate);
                }
            }
        }
        return result;
    }

    /**
     * Hourly: the changes per minute of every recorded datapoint. If a datapoint becomes or stops
     * being high-frequency, the selection runs again and changes its class.
     */
    private evaluateRates(): void {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        const now = Date.now();
        const ids = [...this.dps.values()].map(dp => dp.id);
        const measured = this.rateMeter.close(now, ids);
        if (!measured) {
            return;
        }
        const updates = new Map<number, RateInfo>();
        const switched: string[] = [];
        for (const dp of this.dps.values()) {
            const perMin = measured.get(dp.id) ?? 0;
            const previous = this.rates.get(dp.id);
            if (!previous && !perMin) {
                continue;
            }
            const rate = nextRate(previous, perMin, this.highRate, now);
            updates.set(dp.id, rate);
            this.rates.set(dp.id, rate);
            if (rate.high !== !!previous?.high) {
                switched.push(`${dp.oid} (${perMin}/min${rate.high ? '' : ', normal again'})`);
            }
        }
        try {
            storage.saveRates(updates);
        } catch (e) {
            this.log.error(`Cannot store the rates: ${(e as Error).message}`);
        }
        if (switched.length) {
            this.log.info(`High-frequency classification changed: ${switched.join(', ')}`);
            void this.updateSelection();
        }
    }

    private onThrottle(dpId: number): void {
        this.anomalies
            ?.onThrottle(dpId, this.filter.burstLimit)
            .catch(e => this.log.error(`Anomaly detection: ${(e as Error).message}`));
        const now = Date.now();
        const last = this.throttled.get(dpId);
        this.throttled.set(dpId, now);
        if (last && now - last < THROTTLE_LOG_INTERVAL) {
            return;
        }
        const oid = this.storage?.getDpById(dpId)?.oid || dpId;
        this.log.warn(
            `${oid} changes more than ${this.filter.burstLimit} times per minute and is throttled (defective sensor?)`,
        );
    }

    /** The table of the admin tab "High frequency" (`textSendTo`) */
    private highFrequencyInfo(): { text: string } {
        const rows = [];
        for (const [id, dp] of this.dps) {
            const rate = this.rates.get(dp.id);
            const throttledAt = this.throttled.get(dp.id);
            if (!rate?.high && !throttledAt && !(rate && rate.perMin > this.highRate / 2)) {
                continue;
            }
            rows.push({
                id,
                name: dp.name,
                perMin: rate?.perMin ?? 0,
                maxPerMin: rate?.maxPerMin ?? 0,
                cls: CLASS_NAMES[dp.cls] || 'discrete',
                high: !!rate?.high,
                throttledAt: throttledAt ?? null,
            });
        }
        return {
            text: renderHighFrequency(rows, { highRate: this.highRate, burstLimit: this.filter.burstLimit }, this.lang),
        };
    }

    // ---------------------------------------------------------------- timers

    /** A keyframe at every full hour */
    private scheduleKeyframe(): void {
        const now = Date.now();
        const next = Math.floor(now / HOUR) * HOUR + HOUR;
        this.keyframeTimer = this.setTimeout(() => {
            this.keyframeTimer = null;
            this.flush(this.createKeyframe());
            this.evaluateRates();
            this.closeStatHour();
            this.scheduleKeyframe();
        }, next - now);
    }

    /** Every full hour: the statistics of the hour into the profiles */
    private closeStatHour(): void {
        const end = Math.round(Date.now() / HOUR) * HOUR;
        if (end <= this.stats.start) {
            return;
        }
        const rows = this.stats.close(end);
        if (this.anomalies) {
            this.anomalies.onHour(rows).catch(e => this.log.error(`Anomaly detection: ${(e as Error).message}`));
        } else {
            try {
                this.storage?.writeStatHours(rows);
            } catch (e) {
                this.log.error(`Cannot store the hourly statistics: ${(e as Error).message}`);
            }
        }
    }

    private runRetention(): void {
        if (!this.storage) {
            return;
        }
        try {
            const result = this.storage.retention(this.retentionDays);
            void this.anomalies?.rebuild();
            if (result.deletedFiles.length) {
                this.log.info(`Retention: deleted ${result.deletedFiles.join(', ')}`);
            }
            if (result.trimmedRows) {
                this.log.debug(`Retention: deleted ${result.trimmedRows} rows older than ${this.retentionDays} days`);
            }
        } catch (e) {
            this.log.error(`Retention failed: ${(e as Error).message}`);
        }
    }

    /** Retention daily at 03:30 local time */
    private scheduleRetention(): void {
        this.retentionTimer = this.setTimeout(
            () => {
                this.retentionTimer = null;
                this.runRetention();
                void this.updateInfoStates();
                this.scheduleRetention();
            },
            msUntilLocal(RETENTION_HOUR, RETENTION_MINUTE),
        );
    }

    /** Resets `info.eventsToday` at local midnight */
    private scheduleMidnight(): void {
        this.midnightTimer = this.setTimeout(
            () => {
                this.midnightTimer = null;
                this.eventsToday = 0;
                void this.updateInfoStates();
                this.scheduleMidnight();
            },
            msUntilLocal(0, 0) + 100,
        );
    }

    // ---------------------------------------------------------------- unload

    private onUnload(callback: () => void): void {
        try {
            for (const timer of [this.keyframeTimer, this.retentionTimer, this.midnightTimer, this.reselectTimer]) {
                if (timer) {
                    this.clearTimeout(timer);
                }
            }
            if (this.flushTimer) {
                this.clearInterval(this.flushTimer);
            }
            if (this.replayTimer) {
                this.clearInterval(this.replayTimer);
            }
            if (this.anomalyTimer) {
                this.clearInterval(this.anomalyTimer);
                this.anomalyTimer = null;
            }
            // nothing is switched on unload: after the restart the simulation continues
            this.simulation?.dispose();
            this.flushTimer = null;
            this.replayTimer = null;
            this.keyframeTimer = null;
            this.retentionTimer = null;
            this.midnightTimer = null;
            this.reselectTimer = null;

            // node:sqlite is synchronous: the buffer is on disk before the callback is called
            this.flush(undefined, true);
            this.storage?.close();
            this.storage = null;
        } catch (e) {
            this.log.error(`Error on unload: ${(e as Error).message}`);
        }
        callback();
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new RecorderAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new RecorderAdapter())();
}
