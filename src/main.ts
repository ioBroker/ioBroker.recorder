/*
 * Copyright (c) 2026 bluefox <dogafox@gmail.com>
 *
 * The MIT License (MIT)
 */
import * as utils from '@iobroker/adapter-core';

import { Selection, definitionFromObject } from './lib/selection';
import { classifySource } from './lib/source';
import { DRIVER_NAME } from './lib/sqlite';
import { Storage } from './lib/storage';
import type { DpInfo, Keyframe, RecordedEvent, StoredValue } from './lib/types';
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

/** Last stored value of a datapoint, to detect real changes */
interface CachedValue extends StoredValue {
    ack: boolean;
}

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

class RecorderAdapter extends utils.Adapter {
    private storage: Storage | null = null;
    /** Recorded datapoints by object ID */
    private readonly dps = new Map<string, DpInfo>();
    /** Last stored value per `dp.id` */
    private readonly cache = new Map<number, CachedValue>();
    /** Events not yet written */
    private buffer: RecordedEvent[] = [];
    private droppedEvents = 0;
    private eventsToday = 0;
    private lastDbSize = -1;
    private lastEventsToday = -1;
    private retentionDays = 30;
    private lang: ioBroker.Languages = 'en';

    private flushTimer: ioBroker.Interval | null | undefined = null;
    private keyframeTimer: ioBroker.Timeout | null | undefined = null;
    private retentionTimer: ioBroker.Timeout | null | undefined = null;
    private midnightTimer: ioBroker.Timeout | null | undefined = null;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'recorder' });

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
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

        await this.updateSelection();
        await this.readInitialValues();
        if (!this.storage) {
            // unloaded while starting
            return;
        }

        const now = Date.now();
        this.eventsToday = this.storage.countEvents(localMidnight(), now + 1);

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

    /**
     * Determines the datapoints to record and adapts the subscriptions to the difference.
     * Milestone 1: include and exclude patterns. The semantic selection (type detector, enums,
     * roles) and the reaction to object changes follow in milestone 2.
     */
    private async updateSelection(): Promise<void> {
        const storage = this.storage;
        if (!storage) {
            return;
        }
        const selection = new Selection({
            includePatterns: this.config.includePatterns,
            excludePatterns: this.config.excludePatterns,
            ownNamespace: this.namespace,
        });

        const selected = new Map<string, ioBroker.StateObject>();
        for (const pattern of selection.includePatterns) {
            const objects = await this.getForeignObjectsAsync(pattern, 'state');
            for (const [id, obj] of Object.entries(objects)) {
                if (selection.accepts(id, obj)) {
                    selected.set(id, obj);
                }
            }
        }

        const now = Date.now();
        const activeIds = new Set<number>();
        const added: string[] = [];
        storage.batchMeta(() => {
            for (const [id, obj] of selected) {
                const dp = storage.upsertDp(definitionFromObject(id, obj, this.lang), now);
                activeIds.add(dp.id);
                if (!this.dps.has(id)) {
                    added.push(id);
                }
                this.dps.set(id, dp);
            }
        });
        const removed = [...this.dps.keys()].filter(id => !selected.has(id));
        for (const id of removed) {
            const dp = this.dps.get(id);
            if (dp) {
                this.cache.delete(dp.id);
            }
            this.dps.delete(id);
        }
        storage.deactivateAllExcept(activeIds);

        if (removed.length) {
            await this.unsubscribeForeignStatesAsync(removed);
        }
        if (added.length) {
            await this.subscribeForeignStatesAsync(added);
        }
        if (!this.dps.size) {
            this.log.warn('No states selected for recording. Add include patterns in the instance settings.');
        } else {
            this.log.info(`Recording ${this.dps.size} states (${added.length} added, ${removed.length} removed)`);
        }
    }

    /** Fills the value cache with the current values, so that the first keyframe is complete */
    private async readInitialValues(): Promise<void> {
        const ids = [...this.dps.keys()];
        // in chunks, so that a single request does not get too large
        for (let i = 0; i < ids.length; i += 500) {
            const states = await this.getForeignStatesAsync(ids.slice(i, i + 500));
            for (const [id, state] of Object.entries(states)) {
                const dp = this.dps.get(id);
                if (dp && state) {
                    this.cache.set(dp.id, { ...encodeValue(state.val, dp.type), ack: !!state.ack });
                }
            }
        }
    }

    // ---------------------------------------------------------------- recording

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        const storage = this.storage;
        const dp = this.dps.get(id);
        if (!storage || !dp || !state) {
            return;
        }
        const stored = encodeValue(state.val, dp.type);
        const ack = !!state.ack;
        const previous = this.cache.get(dp.id);
        if (previous && previous.ack === ack && sameValue(previous, stored)) {
            // only the timestamp was updated
            return;
        }
        const ts = state.ts || Date.now();
        if (ts < Date.now() - this.retentionDays * DAY) {
            // an adapter set a timestamp from the past, older than anything we keep
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

    /** Writes the buffer (and a keyframe) in one transaction */
    private flush(keyframe?: Keyframe, updateStates = true): void {
        const storage = this.storage;
        if (!storage || (!this.buffer.length && !keyframe?.rows.length)) {
            return;
        }
        const events = this.buffer;
        this.buffer = [];
        try {
            storage.write(events, keyframe);
        } catch (e) {
            this.log.error(`Cannot write ${events.length} events: ${(e as Error).message}`);
            // keep them for the next attempt, but do not grow without limit
            this.buffer = events.concat(this.buffer);
            if (this.buffer.length > MAX_BUFFER) {
                const drop = this.buffer.length - MAX_BUFFER;
                this.buffer.splice(0, drop);
                this.droppedEvents += drop;
                this.log.error(`Dropped ${drop} events (${this.droppedEvents} in total), the database is not writable`);
            }
            return;
        }
        if (updateStates) {
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
        if (force) {
            await this.setStateAsync('info.recordedCount', this.dps.size, true);
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
            for (const timer of [this.keyframeTimer, this.retentionTimer, this.midnightTimer]) {
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

            // node:sqlite is synchronous: the buffer is on disk before the callback is called
            this.flush(undefined, false);
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
