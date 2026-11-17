/*
 * Copyright (c) 2026 bluefox <dogafox@gmail.com>
 *
 * The MIT License (MIT)
 */
import * as utils from '@iobroker/adapter-core';
import { sendResponse, type IobDataEntry } from '@iobroker/aggregate';

import { Aggregator } from './lib/aggregator';
import { categoryModes } from './lib/categories';
import { parseHistoryRequest, readHistory } from './lib/history';
import { estimateSize, renderPreview, summaryText } from './lib/preview';
import {
    aliasTarget,
    computeSelection,
    DeviceDetection,
    type Candidate,
    type SelectionConfig,
    type SelectionResult,
} from './lib/selection';
import { classifySource } from './lib/source';
import { DRIVER_NAME } from './lib/sqlite';
import { Storage } from './lib/storage';
import { DpClass, type DpInfo, type Keyframe, type RecordedEvent, type StoredValue } from './lib/types';
import { encodeValue, sameValue } from './lib/values';

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
/** Object types the selection looks at */
const SELECTION_TYPES = new Set<string>(['state', 'channel', 'device', 'folder', 'enum']);

/** Last stored value of a datapoint, to detect real changes */
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

/** `chips` stores an array; older or hand-edited configurations may hold a string */
function toPatternList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value === 'string') {
        return value.split(/[,;\n]/);
    }
    return [];
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

        const systemConfig = await this.getForeignObjectAsync('system.config');
        this.lang = systemConfig?.common?.language || 'en';

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
                this.dps.set(id, dp);
                this.reasons.set(id, selected.reason);
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
            }
            this.dps.delete(id);
            this.reasons.delete(id);
        }
        storage.deactivateAllExcept(activeIds);

        if (removed.length) {
            await this.unsubscribeForeignStatesAsync(removed);
        }
        if (added.length) {
            await this.subscribeForeignStatesAsync(added);
            await this.readInitialValues(added);
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
                    this.cache.set(dp.id, { ...encodeValue(state.val, dp.type), ack: !!state.ack });
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
            case 'getSelection':
                respond(this.getSelectionInfo());
                break;

            case 'previewSelection':
                respond(this.previewSelection(obj.message as Partial<ioBroker.AdapterConfig> | undefined));
                break;

            case 'recalculate':
                void this.updateSelection().then(() => respond({ result: `${this.dps.size} states` }));
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
                respond({ error: `Unknown command: ${obj.command}` });
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

    // ---------------------------------------------------------------- recording

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
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

        if (dp.cls === DpClass.Aggregated && stored.val !== null) {
            // every sample counts for the mean, also unchanged ones
            this.aggregator.add(dp.id, ts, stored.val);
            this.cache.set(dp.id, { ...stored, ack });
            return;
        }

        const previous = this.cache.get(dp.id);
        if (previous && previous.ack === ack && sameValue(previous, stored)) {
            // only the timestamp was updated
            return;
        }
        this.cache.set(dp.id, { ...stored, ack });
        this.buffer.push({
            ts,
            dp: dp.id,
            val: stored.val,
            sval: stored.sval,
            ack,
            src: storage.getSourceId(state.from, state.user, classifySource(state.from)),
        });
        this.eventsToday++;

        if (this.buffer.length >= MAX_BATCH) {
            this.flush();
        }
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
        const aggregates = final ? this.aggregator.takeAll() : this.aggregator.takeClosed(Date.now());
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

    // ---------------------------------------------------------------- timers

    /** A keyframe at every full hour */
    private scheduleKeyframe(): void {
        const now = Date.now();
        const next = Math.floor(now / HOUR) * HOUR + HOUR;
        this.keyframeTimer = this.setTimeout(() => {
            this.keyframeTimer = null;
            this.flush(this.createKeyframe());
            this.scheduleKeyframe();
        }, next - now);
    }

    private runRetention(): void {
        if (!this.storage) {
            return;
        }
        try {
            const result = this.storage.retention(this.retentionDays);
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
            this.flushTimer = null;
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
