import { categoryLabel, type SelectedDp, type SelectionResult } from './selection';
import { DpClass } from './types';

/** Measured size of one row incl. indexes (load test of milestone 1) */
const EVENT_BYTES = 70;
const AGGREGATE_BYTES = 50;
const KEYFRAME_BYTES = 35;
/** Assumed changes per day of a datapoint without measured data */
const DEFAULT_CHANGES: Record<DpClass, number> = {
    [DpClass.Discrete]: 20,
    [DpClass.Continuous]: 50,
    [DpClass.Aggregated]: 288, // one row per 5 minutes
    [DpClass.Discarded]: 0,
};
/** Rows shown in the admin at most */
const MAX_ROWS = 1000;

export interface SizeEstimate {
    count: number;
    /** MB per 30 days */
    mbPerMonth: number;
    /** MB for the configured retention */
    mbRetention: number;
    /** How many datapoints have measured rates (the others are assumed) */
    measured: number;
}

/**
 * Estimates the database size of a selection.
 *
 * @param selected the selected datapoints
 * @param changesPerDay measured changes per day by object ID (from the recorded data)
 * @param retentionDays configured retention
 */
export function estimateSize(
    selected: SelectedDp[],
    changesPerDay: Map<string, number>,
    retentionDays: number,
): SizeEstimate {
    let bytesPerDay = 0;
    let measured = 0;
    for (const dp of selected) {
        if (dp.cls === DpClass.Aggregated) {
            bytesPerDay += DEFAULT_CHANGES[DpClass.Aggregated] * AGGREGATE_BYTES;
        } else {
            const rate = changesPerDay.get(dp.oid);
            if (rate !== undefined) {
                measured++;
            }
            bytesPerDay += (rate ?? DEFAULT_CHANGES[dp.cls]) * EVENT_BYTES;
        }
        bytesPerDay += 24 * KEYFRAME_BYTES;
    }
    const mb = (days: number): number => Math.round((bytesPerDay * days) / 1_048_576);
    return { count: selected.length, mbPerMonth: mb(30), mbRetention: mb(retentionDays), measured };
}

const TEXTS = {
    en: {
        summary: '%count states, about %month MB per month (%retention MB for %days days)',
        measured: 'Rates measured for %measured states, assumed for the others.',
        duration: 'Examined %examined states in %ms ms.',
        dropped: 'Not recorded',
        more: '... and %n more',
        category: 'Category',
        id: 'ID',
        name: 'Name',
        room: 'Room',
        cls: 'Class',
        reason: 'Reason',
        manual: 'manual',
        classes: ['discrete', 'continuous', 'aggregated', 'discarded'],
    },
    de: {
        summary: '%count Datenpunkte, ca. %month MB pro Monat (%retention MB für %days Tage)',
        measured: 'Raten für %measured Datenpunkte gemessen, für die übrigen geschätzt.',
        duration: '%examined Datenpunkte in %ms ms geprüft.',
        dropped: 'Nicht aufgezeichnet',
        more: '... und %n weitere',
        category: 'Kategorie',
        id: 'ID',
        name: 'Name',
        room: 'Raum',
        cls: 'Klasse',
        reason: 'Begründung',
        manual: 'manuell',
        classes: ['diskret', 'kontinuierlich', 'aggregiert', 'verworfen'],
    },
};

function escapeHtml(text: string | null | undefined): string {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function format(template: string, values: Record<string, string | number>): string {
    return template.replace(/%(\w+)/g, (m, key: string) => (key in values ? String(values[key]) : m));
}

/** One line for the log and for scripts */
export function summaryText(estimate: SizeEstimate, retentionDays: number, lang: ioBroker.Languages): string {
    const t = lang === 'de' ? TEXTS.de : TEXTS.en;
    return format(t.summary, {
        count: estimate.count,
        month: estimate.mbPerMonth,
        retention: estimate.mbRetention,
        days: retentionDays,
    });
}

/** HTML for the `textSendTo` control (container `html`) of the tab "Preview" */
export function renderPreview(
    result: SelectionResult,
    estimate: SizeEstimate,
    retentionDays: number,
    lang: ioBroker.Languages,
): string {
    const t = lang === 'de' ? TEXTS.de : TEXTS.en;
    const rows = [...result.selected.values()].sort(
        (a, b) => (a.category || '~').localeCompare(b.category || '~') || a.oid.localeCompare(b.oid),
    );
    const cell = 'style="padding: 2px 8px; border-bottom: 1px solid rgba(128,128,128,0.3); text-align: left"';

    const html: string[] = [];
    html.push(`<p><b>${escapeHtml(summaryText(estimate, retentionDays, lang))}</b><br/>`);
    html.push(`${escapeHtml(format(t.measured, { measured: estimate.measured }))} `);
    html.push(`${escapeHtml(format(t.duration, { examined: result.examined, ms: result.durationMs }))}</p>`);

    const dropped = Object.entries(result.dropped).sort((a, b) => b[1] - a[1]);
    if (dropped.length) {
        html.push(
            `<p>${escapeHtml(t.dropped)}: ${dropped.map(([reason, n]) => `${escapeHtml(reason)} (${n})`).join(', ')}</p>`,
        );
    }

    html.push('<table style="border-collapse: collapse; width: 100%; font-size: 0.9em">');
    html.push(
        `<tr>${[t.category, t.id, t.name, t.room, t.cls, t.reason].map(h => `<th ${cell}>${escapeHtml(h)}</th>`).join('')}</tr>`,
    );
    for (const dp of rows.slice(0, MAX_ROWS)) {
        html.push(
            `<tr>${[
                dp.category ? categoryLabel(dp.category, lang) : t.manual,
                dp.oid,
                dp.name,
                dp.room,
                t.classes[dp.cls],
                dp.reason,
            ]
                .map(v => `<td ${cell}>${escapeHtml(v)}</td>`)
                .join('')}</tr>`,
        );
    }
    html.push('</table>');
    if (rows.length > MAX_ROWS) {
        html.push(`<p>${escapeHtml(format(t.more, { n: rows.length - MAX_ROWS }))}</p>`);
    }
    return html.join('');
}
