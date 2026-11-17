import type { StoredValue, ValueType } from './types';

/** Maps `common.type` to the encoding in the database */
export function valueTypeOf(commonType: string | undefined): ValueType {
    switch (commonType) {
        case 'boolean':
            return 'boolean';
        case 'number':
            return 'number';
        case 'string':
            return 'string';
        default:
            // array, object, json, mixed, file and unknown types are stored as JSON
            return 'json';
    }
}

/**
 * Encodes a state value for the columns `val` (numbers, booleans as 0/1) and `sval` (text).
 * Values that do not fit their declared type (a boolean state that receives "on") are kept as
 * text instead of being lost.
 */
export function encodeValue(value: ioBroker.StateValue | undefined, type: ValueType): StoredValue {
    if (value === null || value === undefined) {
        return { val: null, sval: null };
    }
    switch (type) {
        case 'boolean':
            if (typeof value === 'boolean') {
                return { val: value ? 1 : 0, sval: null };
            }
            if (value === 'true' || value === 1) {
                return { val: 1, sval: null };
            }
            if (value === 'false' || value === 0) {
                return { val: 0, sval: null };
            }
            return { val: null, sval: String(value) };

        case 'number':
            if (typeof value === 'number') {
                return Number.isFinite(value) ? { val: value, sval: null } : { val: null, sval: String(value) };
            }
            if (typeof value === 'boolean') {
                return { val: value ? 1 : 0, sval: null };
            }
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
                return { val: Number(value), sval: null };
            }
            return { val: null, sval: String(value) };

        case 'string':
            return { val: null, sval: typeof value === 'string' ? value : JSON.stringify(value) };

        default:
            // always JSON, so that the original JS type survives the round trip
            return { val: null, sval: JSON.stringify(value) };
    }
}

/** Decodes the columns `val` / `sval` back into a state value */
export function decodeValue(stored: StoredValue, type: ValueType): ioBroker.StateValue {
    if (stored.sval !== null) {
        if (type === 'json') {
            try {
                return JSON.parse(stored.sval) as ioBroker.StateValue;
            } catch {
                return stored.sval;
            }
        }
        return stored.sval;
    }
    if (stored.val === null) {
        return null;
    }
    if (type === 'boolean') {
        return stored.val !== 0;
    }
    return stored.val;
}

/** True if two stored values are the same */
export function sameValue(a: StoredValue, b: StoredValue): boolean {
    return a.val === b.val && a.sval === b.sval;
}
