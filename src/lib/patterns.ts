/** Converts an ioBroker ID pattern with `*` as wildcard to a regular expression */
export function patternToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .trim()
        .split('*')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`);
}

/** Matches object IDs against a list of patterns */
export class PatternList {
    private readonly regExps: RegExp[];

    public constructor(patterns: string[] | undefined) {
        this.regExps = (patterns || []).filter(p => p?.trim()).map(p => patternToRegExp(p));
    }

    public get isEmpty(): boolean {
        return !this.regExps.length;
    }

    public matches(id: string): boolean {
        return this.regExps.some(r => r.test(id));
    }
}
