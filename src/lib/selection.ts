import { PatternList } from './patterns';
import { DpClass, type DpDefinition } from './types';
import { valueTypeOf } from './values';

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
 * Initial storage class from the object alone. Milestone 3 refines it by measuring the rate of
 * changes (high-frequency datapoints become "aggregated").
 */
export function initialClass(common: ioBroker.StateCommon): DpClass {
    if (common.type === 'number' && !common.states) {
        return DpClass.Continuous;
    }
    return DpClass.Discrete;
}

/** Builds the master data of a datapoint from its object */
export function definitionFromObject(id: string, obj: ioBroker.StateObject, lang: ioBroker.Languages): DpDefinition {
    const common = obj.common;
    return {
        oid: id,
        name: translatedName(common.name, lang),
        // rooms, functions, device type and category come from the selection engine (milestone 2)
        room: null,
        func: null,
        devType: null,
        category: null,
        role: common.role || null,
        unit: common.unit || null,
        cls: initialClass(common),
        type: valueTypeOf(common.type),
        states: common.states ? JSON.stringify(common.states) : null,
    };
}

export interface SelectionOptions {
    includePatterns: string[];
    excludePatterns: string[];
    /** Own namespace, e.g. `recorder.0` - never recorded, the info states change with every write */
    ownNamespace: string;
}

/** Decides whether a state object is recorded */
export class Selection {
    private readonly exclude: PatternList;

    public constructor(private readonly options: SelectionOptions) {
        this.exclude = new PatternList(options.excludePatterns);
    }

    /** Patterns to read the candidate objects with */
    public get includePatterns(): string[] {
        return (this.options.includePatterns || []).map(p => p.trim()).filter(p => p);
    }

    public accepts(id: string, obj: ioBroker.Object | null | undefined): obj is ioBroker.StateObject {
        if (obj?.type !== 'state') {
            return false;
        }
        if (id === this.options.ownNamespace || id.startsWith(`${this.options.ownNamespace}.`)) {
            return false;
        }
        return !this.exclude.matches(id);
    }
}
