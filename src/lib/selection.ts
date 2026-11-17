import ChannelDetector, { type DetectOptions, Types } from '@iobroker/type-detector';

import {
    CATEGORIES,
    ENERGY_STATES,
    categoryOfRole,
    categoryOfType,
    isNegativeRole,
    type CategoryKey,
    type CategoryMode,
} from './categories';
import { PatternList } from './patterns';
import { DpClass, type DpDefinition } from './types';
import { valueTypeOf } from './values';

/** Settings of the per-state dialog (`common.custom[recorder.0]`) */
export interface RecorderCustom {
    enabled?: boolean;
    /** always: record even if the automatic selection does not; exclude: never record */
    mode?: 'always' | 'exclude';
}

export interface SelectionConfig {
    categories: Record<CategoryKey, CategoryMode>;
    /** Only states that belong (directly or by their channel/device) to a room or function */
    requireEnum: boolean;
    includePatterns: string[];
    excludePatterns: string[];
    /** e.g. `recorder.0`: never recorded itself, and the key of the per-state settings */
    ownNamespace: string;
    lang: ioBroker.Languages;
}

/** A selected datapoint with the reason, why it was selected */
export interface SelectedDp extends DpDefinition {
    reason: string;
}

export interface SelectionResult {
    selected: Map<string, SelectedDp>;
    /** Number of state objects examined */
    examined: number;
    /** States found by the automatic levels but dropped, by reason */
    dropped: Record<string, number>;
    durationMs: number;
}

/** Room and function names of an object */
interface EnumInfo {
    rooms: string[];
    funcs: string[];
}

/** A candidate found by the automatic levels (type detector or role) */
export interface Candidate {
    category: CategoryKey;
    devType: string | null;
    reason: string;
}

/** Roles of stand-alone states that cannot describe a device; the detector is not called for them */
const MEANINGLESS_ROLES = new Set(['', 'state', 'value', 'text', 'json', 'url', 'html', 'list', 'date', 'media']);

export function parentOf(id: string): string {
    const pos = id.lastIndexOf('.');
    return pos === -1 ? '' : id.substring(0, pos);
}

/** Reads a possibly translated name in the system language */
export function translatedName(name: ioBroker.StringOrTranslated | undefined, lang: ioBroker.Languages): string | null {
    if (!name) {
        return null;
    }
    if (typeof name === 'string') {
        return name;
    }
    return name[lang] || name.en || Object.values(name).find(v => typeof v === 'string' && v) || null;
}

/**
 * Initial storage class from the object and the category mode. Milestone 3 refines it by measuring
 * the rate of changes.
 */
export function initialClass(common: ioBroker.StateCommon, mode: CategoryMode | undefined): DpClass {
    if (common.type === 'number' && !common.states) {
        return mode === 'aggregated' ? DpClass.Aggregated : DpClass.Continuous;
    }
    return DpClass.Discrete;
}

function buildEnumIndex(objects: Record<string, ioBroker.Object>, lang: ioBroker.Languages): Map<string, EnumInfo> {
    const index = new Map<string, EnumInfo>();
    for (const [id, obj] of Object.entries(objects)) {
        if (obj?.type !== 'enum') {
            continue;
        }
        const isRoom = id.startsWith('enum.rooms.');
        if (!isRoom && !id.startsWith('enum.functions.')) {
            continue;
        }
        const name = translatedName(obj.common?.name, lang) || id.split('.').pop() || id;
        for (const member of obj.common?.members || []) {
            let info = index.get(member);
            if (!info) {
                info = { rooms: [], funcs: [] };
                index.set(member, info);
            }
            (isRoom ? info.rooms : info.funcs).push(name);
        }
    }
    return index;
}

/** Rooms and functions of a state: its own, else those of its channel, else those of its device */
function enumsOf(id: string, index: Map<string, EnumInfo>): EnumInfo {
    const result: EnumInfo = { rooms: [], funcs: [] };
    let current = id;
    // state, channel, device - an adapter instance (two segments) is not a member that counts
    for (let level = 0; level < 3 && current.split('.').length > 2; level++) {
        const info = index.get(current);
        if (info) {
            if (!result.rooms.length) {
                result.rooms = info.rooms;
            }
            if (!result.funcs.length) {
                result.funcs = info.funcs;
            }
        }
        if (result.rooms.length && result.funcs.length) {
            break;
        }
        current = parentOf(current);
    }
    return result;
}

/** Direct children of `id` in the sorted `keys` (binary search for the first one) */
function directChildren(keys: string[], id: string): string[] {
    const prefix = `${id}.`;
    let low = 0;
    let high = keys.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (keys[mid] < prefix) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    const children: string[] = [];
    for (let i = low; i < keys.length && keys[i].startsWith(prefix); i++) {
        if (!keys[i].includes('.', prefix.length)) {
            children.push(keys[i]);
        }
    }
    return children;
}

function isOwnOrSystem(id: string, ownNamespace: string): boolean {
    return id.startsWith('system.') || id === ownNamespace || id.startsWith(`${ownNamespace}.`);
}

/** The ID an alias reads from */
function aliasTarget(obj: ioBroker.StateObject): string | null {
    const alias = (obj.common as { alias?: { id?: string | { read?: string } } }).alias;
    if (!alias?.id) {
        return null;
    }
    return typeof alias.id === 'string' ? alias.id : alias.id.read || null;
}

/** A state found by the type detector */
interface DetectedState extends Candidate {
    id: string;
}

/** After this many detector calls, `update()` gives the event loop a chance */
const DETECT_CHUNK = 200;

/**
 * Level 1: the type detector. Every channel, every device with direct states and every stand-alone
 * state is examined; each state is assigned to the first control it is found in.
 *
 * The detection depends only on the objects, not on the configuration, and it is the expensive
 * part of the selection (about 0.6 s for 40,000 states on a desktop CPU). So the results are kept
 * per examined object; after object changes only the changed objects, their channels and their
 * devices are examined again.
 */
export class DeviceDetection {
    /** Results per examined object (channel, device or stand-alone state) */
    private readonly results = new Map<string, DetectedState[]>();
    private readonly dirty = new Set<string>();
    private full = true;

    public constructor(private readonly ownNamespace: string) {}

    /** Marks an object as changed (or deleted) */
    public invalidate(id: string): void {
        if (id.startsWith('enum.')) {
            // some patterns of the detector use the function enums
            this.full = true;
        } else {
            this.dirty.add(id);
        }
    }

    /**
     * Brings the results up to date and returns the detected states by state ID.
     *
     * @param objects all objects of the selection
     * @param keys sorted IDs of `objects`
     * @param pause called between chunks of detections, e.g. to give the event loop a chance
     */
    public async update(
        objects: Record<string, ioBroker.Object>,
        keys: string[],
        pause?: () => Promise<void>,
    ): Promise<Map<string, Candidate>> {
        const todo = this.prepare(objects, keys);
        const detect = this.createDetect(objects, keys);
        for (let i = 0; i < todo.length; i++) {
            detect(todo[i]);
            if (pause && i % DETECT_CHUNK === DETECT_CHUNK - 1) {
                await pause();
            }
        }
        return this.byState(keys);
    }

    /** Synchronous variant of `update()` */
    public updateSync(objects: Record<string, ioBroker.Object>, keys: string[]): Map<string, Candidate> {
        const todo = this.prepare(objects, keys);
        const detect = this.createDetect(objects, keys);
        for (const id of todo) {
            detect(id);
        }
        return this.byState(keys);
    }

    /** Returns the IDs that have to be examined and forgets their old results */
    private prepare(objects: Record<string, ioBroker.Object>, keys: string[]): string[] {
        const parentsWithStates = new Set<string>();
        for (const id of keys) {
            if (objects[id]?.type === 'state') {
                parentsWithStates.add(parentOf(id));
            }
        }
        let affected: Iterable<string>;
        if (this.full) {
            this.results.clear();
            affected = keys;
        } else {
            const set = new Set<string>();
            for (const id of this.dirty) {
                // the object itself, its channel and its device
                let current = id;
                for (let level = 0; current && level < 3; level++) {
                    set.add(current);
                    current = parentOf(current);
                }
                // a deleted or changed channel/device turns its states into stand-alone states or back
                if (objects[id]?.type !== 'state') {
                    for (const child of directChildren(keys, id)) {
                        set.add(child);
                    }
                }
            }
            for (const id of set) {
                this.results.delete(id);
            }
            affected = set;
        }
        this.full = false;
        this.dirty.clear();

        const todo: string[] = [];
        for (const id of affected) {
            if (this.isCandidate(objects, id, parentsWithStates)) {
                todo.push(id);
            }
        }
        return todo;
    }

    private isCandidate(objects: Record<string, ioBroker.Object>, id: string, parentsWithStates: Set<string>): boolean {
        const obj = objects[id];
        if (!obj || isOwnOrSystem(id, this.ownNamespace)) {
            return false;
        }
        if (obj.type === 'channel') {
            return true;
        }
        if (obj.type === 'device') {
            return parentsWithStates.has(id);
        }
        if (obj.type === 'state') {
            const parentType = objects[parentOf(id)]?.type;
            if (parentType === 'channel' || parentType === 'device') {
                return false;
            }
            const role = obj.common?.role || '';
            return !MEANINGLESS_ROLES.has(role) && !isNegativeRole(role) && !role.startsWith('indicator');
        }
        return false;
    }

    /** A detect function with a fresh detector: the detector caches its results per ID */
    private createDetect(objects: Record<string, ioBroker.Object>, keys: string[]): (id: string) => void {
        const detector = new ChannelDetector();
        const options: DetectOptions = {
            objects,
            id: '',
            _keysOptional: keys,
            _keysOptionalSorted: true,
            ignoreIndicators: ['UNREACH_STICKY'],
            excludedTypes: [Types.info],
        };
        return (id: string): void => {
            const parentType = objects[parentOf(id)]?.type;
            options.id = id;
            options._usedIdsOptional = [];
            options.detectOnlyChannel = parentType === 'channel' || parentType === 'device';
            let controls: ReturnType<ChannelDetector['detect']>;
            try {
                controls = detector.detect(options);
            } catch {
                // a broken object must not stop the selection
                return;
            }
            const found: DetectedState[] = [];
            for (const control of controls || []) {
                const category = categoryOfType(control.type);
                for (const state of control.states) {
                    if (!state.id) {
                        continue;
                    }
                    const reason = `Type detector: ${control.type}.${state.name}`;
                    if (ENERGY_STATES.includes(state.name)) {
                        found.push({ id: state.id, category: 'energy', devType: control.type, reason });
                    } else if (category?.states.includes(state.name)) {
                        found.push({ id: state.id, category: category.key, devType: control.type, reason });
                    }
                }
            }
            if (found.length) {
                this.results.set(id, found);
            }
        };
    }

    /** The results by state ID; a state found in several controls keeps the first one (in ID order) */
    private byState(keys: string[]): Map<string, Candidate> {
        const candidates = new Map<string, Candidate>();
        for (const id of keys) {
            for (const state of this.results.get(id) || []) {
                if (!candidates.has(state.id)) {
                    candidates.set(state.id, {
                        category: state.category,
                        devType: state.devType,
                        reason: state.reason,
                    });
                }
            }
        }
        return candidates;
    }
}

/**
 * Computes which states are recorded. Four levels, a later one overrides an earlier one:
 *
 * 1. type detector: detected devices and the meaning of their states give the category
 * 2. enums: with `requireEnum` only states in a room or function
 * 3. roles: positive list for states without a detected device, negative list for all
 * 4. manual rules: include and exclude patterns, then the per-state setting `common.custom`
 *
 * @param objects all objects of the types state, channel, device, folder and enum
 * @param config the configuration
 * @param detected result of `DeviceDetection`; computed here if not given
 * @param keys sorted IDs of `objects`, if already known
 */
export function computeSelection(
    objects: Record<string, ioBroker.Object>,
    config: SelectionConfig,
    detected?: Map<string, Candidate>,
    keys: string[] = Object.keys(objects).sort(),
): SelectionResult {
    const start = Date.now();
    const enumIndex = buildEnumIndex(objects, config.lang);
    detected ||= new DeviceDetection(config.ownNamespace).updateSync(objects, keys);
    const include = new PatternList(config.includePatterns);
    const exclude = new PatternList(config.excludePatterns);

    const selected = new Map<string, SelectedDp>();
    const dropped: Record<string, number> = {};
    const drop = (reason: string): void => {
        dropped[reason] = (dropped[reason] || 0) + 1;
    };
    const aliasTargets = new Map<string, string>();
    let examined = 0;

    for (const id of keys) {
        const obj = objects[id];
        if (obj?.type !== 'state' || !obj.common) {
            continue;
        }
        examined++;
        if (id === config.ownNamespace || id.startsWith(`${config.ownNamespace}.`)) {
            continue;
        }
        const common = obj.common;
        const role = common.role || '';

        // levels 1 and 3: automatic candidates
        let candidate: Candidate | null = null;
        if (!isOwnOrSystem(id, config.ownNamespace)) {
            candidate = detected.get(id) || null;
            if (!candidate) {
                const category = categoryOfRole(role);
                if (category) {
                    candidate = { category: category.key, devType: null, reason: `Role ${role}` };
                }
            }
            if (candidate && isNegativeRole(role)) {
                drop('negative role');
                candidate = null;
            }
            if (candidate && common.read === false) {
                drop('not readable');
                candidate = null;
            }
            if (candidate && config.categories[candidate.category] === 'off') {
                drop(`category ${candidate.category} off`);
                candidate = null;
            }
        }

        const enums = enumsOf(id, enumIndex);
        // level 2
        if (candidate && config.requireEnum && !enums.rooms.length && !enums.funcs.length) {
            drop('no room or function');
            candidate = null;
        }

        // level 4
        let reason = candidate?.reason || '';
        let take = !!candidate;
        if (include.matches(id)) {
            take = true;
            reason ||= 'Include rule';
        }
        if (take && exclude.matches(id)) {
            take = false;
            drop('exclude rule');
        }
        const custom = common.custom?.[config.ownNamespace] as RecorderCustom | undefined;
        if (custom?.enabled) {
            if (custom.mode === 'exclude') {
                if (take) {
                    drop('custom exclude');
                }
                take = false;
            } else {
                take = true;
                reason = 'Custom: always';
            }
        }
        if (!take) {
            continue;
        }

        const category = candidate?.category || null;
        selected.set(id, {
            oid: id,
            name: translatedName(common.name, config.lang),
            room: enums.rooms.join(', ') || null,
            func: enums.funcs.join(', ') || null,
            role: role || null,
            unit: common.unit || null,
            devType: candidate?.devType || null,
            category,
            cls: initialClass(common, category ? config.categories[category] : undefined),
            type: valueTypeOf(common.type),
            states: common.states ? JSON.stringify(common.states) : null,
            reason,
        });
        if (id.startsWith('alias.')) {
            const target = aliasTarget(obj);
            if (target) {
                aliasTargets.set(target, id);
            }
        }
    }

    // An alias and its target carry the same values. The alias is kept (it was set up by the user,
    // with name and room), the target is dropped, unless the user asked for it explicitly.
    for (const [target, alias] of aliasTargets) {
        const dp = selected.get(target);
        if (dp && !dp.reason.startsWith('Include') && !dp.reason.startsWith('Custom')) {
            selected.delete(target);
            drop('covered by alias');
            const aliasDp = selected.get(alias);
            if (aliasDp) {
                aliasDp.reason += ` (alias of ${target})`;
            }
        }
    }

    return { selected, examined, dropped, durationMs: Date.now() - start };
}

/** Labels of the categories for texts in the admin */
export function categoryLabel(key: string | null, lang: ioBroker.Languages): string {
    if (!key) {
        return '';
    }
    const category = CATEGORIES.find(c => c.key === key);
    if (!category) {
        return key;
    }
    return lang === 'de' ? category.label.de : category.label.en;
}
