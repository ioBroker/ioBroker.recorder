import { I18n } from '@iobroker/gui-components';

import type { JournalEntry, SnapshotEntry } from './api';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The categories of the recorder in the order of the tiles */
export const CATEGORIES = [
    'light',
    'shading',
    'climate',
    'windowsDoors',
    'motion',
    'security',
    'sockets',
    'media',
    'weather',
    'energy',
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
    light: 'Lights',
    shading: 'Shading',
    climate: 'Climate',
    windowsDoors: 'Windows and doors',
    motion: 'Motion',
    security: 'Security',
    sockets: 'Sockets',
    media: 'Media',
    weather: 'Weather',
    energy: 'Energy',
};

/** Order of a category in the tiles; unknown ones last */
export function categoryOrder(category: string | null): number {
    const index = CATEGORIES.indexOf((category || '') as (typeof CATEGORIES)[number]);
    return index < 0 ? CATEGORIES.length : index;
}

function language(): string {
    const lang = I18n.getLanguage();
    return lang === 'zh-cn' ? 'zh-CN' : lang;
}

/**
 * `toLocaleTimeString`, `toLocaleString` and `localeCompare` create a new ICU formatter with every
 * call, which costs a few hundred milliseconds for the rows of one snapshot. The formatters are
 * created once per language.
 */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.Collator>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.Collator>(
    key: string,
    create: (lang: string) => T,
): T {
    const lang = language();
    const id = `${lang}|${key}`;
    let formatter = formatters.get(id) as T | undefined;
    if (!formatter) {
        formatter = create(lang);
        formatters.set(id, formatter);
    }
    return formatter;
}

/** Compares names in the order of the language */
export function compareText(a: string, b: string): number {
    return cached('collator', lang => new Intl.Collator(lang)).compare(a, b);
}

/** "07:12" or "07:12:45" */
export function formatTime(ts: number, seconds = false): string {
    return cached(
        seconds ? 'time-s' : 'time',
        lang =>
            new Intl.DateTimeFormat(lang, {
                hour: '2-digit',
                minute: '2-digit',
                second: seconds ? '2-digit' : undefined,
            }),
    ).format(ts);
}

/** "Mo., 16.11.2026" */
export function formatDate(ts: number): string {
    return cached(
        'date',
        lang => new Intl.DateTimeFormat(lang, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }),
    ).format(ts);
}

/** "Montag, 16.11." for the day lines of the journal */
export function formatDay(ts: number): string {
    return cached(
        'day',
        lang => new Intl.DateTimeFormat(lang, { weekday: 'long', day: '2-digit', month: '2-digit' }),
    ).format(ts);
}

/** "16.11. 07:12" */
export function formatShort(ts: number): string {
    return `${cached('short', lang => new Intl.DateTimeFormat(lang, { day: '2-digit', month: '2-digit' })).format(ts)} ${formatTime(ts)}`;
}

/** Value for `<input type="datetime-local">` in local time */
export function toLocalInput(ts: number): string {
    const d = new Date(ts - new Date(ts).getTimezoneOffset() * MINUTE);
    return d.toISOString().slice(0, 16);
}

type Valued = Pick<SnapshotEntry, 'val' | 'text' | 'unit' | 'role' | 'category'>;

function isWindowLike(entry: Valued): boolean {
    const role = entry.role || '';
    return entry.category === 'windowsDoors' || role.includes('window') || role.includes('door');
}

/** The value as text: the text of `common.states`, on/off, open/closed, or the number with unit */
export function formatValue(entry: Valued): string {
    if (entry.text !== undefined) {
        return entry.text;
    }
    const val = entry.val;
    if (val === null || val === undefined) {
        return '–';
    }
    if (typeof val === 'boolean') {
        if (isWindowLike(entry)) {
            return I18n.t(val ? 'open' : 'closed');
        }
        if (entry.category === 'motion' || (entry.role || '').includes('motion')) {
            return I18n.t(val ? 'motion' : 'no motion');
        }
        return I18n.t(val ? 'on' : 'off');
    }
    if (typeof val === 'number') {
        const digits = Math.abs(val) < 10 ? 2 : 1;
        const text = cached(
            `number-${digits}`,
            lang => new Intl.NumberFormat(lang, { maximumFractionDigits: digits }),
        ).format(val);
        return entry.unit ? `${text} ${entry.unit}` : text;
    }
    const text = typeof val === 'string' ? val : JSON.stringify(val);
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** True if the value means "active": light on, window open, motion */
export function isActive(entry: Valued): boolean {
    const val = entry.val;
    if (typeof val === 'boolean') {
        return val;
    }
    if (typeof val === 'number') {
        // a dimmer or a window with states (0 closed, 1 tilted, 2 open)
        return (entry.category === 'light' || isWindowLike(entry)) && val > 0;
    }
    return false;
}

/** Who caused a change: "admin, vis-2.0", "Script common.Light, javascript.0", "hue.0", "System" */
export function formatSource(entry: Pick<JournalEntry, 'src' | 'from' | 'user' | 'c'>): string {
    const instance = entry.from?.replace(/^system\.adapter\./, '') || '';
    if (entry.src === 'script' && entry.c) {
        // javascript writes its script into `c`: "script.js.common.Light" -> "common.Light"
        const script = entry.c.replace(/^script\.js\./, '');
        return I18n.t('Script %s', instance ? `${script}, ${instance}` : script);
    }
    switch (entry.src) {
        case 'user': {
            const user = entry.user?.replace(/^system\.user\./, '') || I18n.t('user');
            return instance ? `${user}, ${instance}` : user;
        }
        case 'script':
            return I18n.t('Script %s', instance);
        case 'adapter':
            return instance || I18n.t('Device');
        default:
            return I18n.t('System');
    }
}

/** A tick interval for the time axis so that about `count` labels fit */
export function tickInterval(span: number, count: number): number {
    const steps = [
        MINUTE,
        5 * MINUTE,
        15 * MINUTE,
        30 * MINUTE,
        HOUR,
        3 * HOUR,
        6 * HOUR,
        12 * HOUR,
        DAY,
        2 * DAY,
        7 * DAY,
    ];
    return steps.find(step => span / step <= count) || 7 * DAY;
}

/** Local time ticks in `[start, end]` */
export function ticks(start: number, end: number, step: number): number[] {
    const result: number[] = [];
    const offset = new Date(start).getTimezoneOffset() * MINUTE;
    // align to local midnight for day steps, to the step otherwise
    let t = Math.ceil((start - offset) / step) * step + offset;
    if (step >= DAY) {
        const d = new Date(start);
        d.setHours(0, 0, 0, 0);
        t = d.getTime();
        while (t < start) {
            t += step;
        }
    }
    for (; t <= end; t += step) {
        result.push(t);
    }
    return result;
}
