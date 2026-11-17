import React from 'react';
import { Box, Typography } from '@mui/material';
import { I18n } from '@iobroker/gui-components';

import type { JournalEntry } from '../api';
import { formatDay, formatSource, formatTime, formatValue } from '../format';

interface JournalProps {
    /** Newest first */
    events: JournalEntry[];
    /** There were more events in the period than loaded */
    more: boolean;
    seconds: boolean;
    onSelect: (ts: number) => void;
}

/**
 * The styles of all lines in one place: hundreds of lines with their own `sx` or MUI components
 * cost about a quarter of a second per render, plain elements with classes almost nothing.
 */
const LIST_SX = {
    display: 'flex',
    flexDirection: 'column',
    typography: 'body2',
    '& .j-day': {
        typography: 'caption',
        color: 'text.secondary',
        px: 1,
        pt: 1,
        borderTop: 1,
        borderColor: 'divider',
    },
    '& .j-line': {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 1,
        px: 1,
        py: 0.5,
        cursor: 'pointer',
        borderLeft: '3px solid transparent',
        '&:hover': { bgcolor: 'action.hover' },
    },
    '& .j-manual': { borderLeftColor: 'secondary.main' },
    '& .j-time': { color: 'text.secondary', fontVariantNumeric: 'tabular-nums' },
    '& .j-text': { minWidth: 0, overflowWrap: 'anywhere' },
    '& .j-room': { opacity: 0.7 },
    '& .j-src': { opacity: 0.6 },
    '& .j-more': { typography: 'caption', color: 'text.secondary', p: 1 },
} as const;

/** The changes before the cursor: "07:12 Bad · Licht an (admin, vis-2.0)" */
function JournalList(props: JournalProps): React.JSX.Element {
    const { events, onSelect } = props;
    if (!events.length) {
        return (
            <Typography
                color="text.secondary"
                variant="body2"
                sx={{ p: 2 }}
            >
                {I18n.t('No changes in the hours before.')}
            </Typography>
        );
    }
    let lastDay = new Date(events[0].ts).toDateString();
    const lines: React.JSX.Element[] = [];
    events.forEach((event, i) => {
        // a line with the date where the day changes
        const day = new Date(event.ts).toDateString();
        if (day !== lastDay) {
            lastDay = day;
            lines.push(
                <div
                    key={`day-${day}`}
                    className="j-day"
                >
                    {formatDay(event.ts)}
                </div>,
            );
        }
        lines.push(
            <div
                key={`${event.ts}-${event.id}-${i}`}
                className={event.src === 'user' ? 'j-line j-manual' : 'j-line'}
                data-ts={event.ts}
                title={event.id}
            >
                <span className="j-time">{formatTime(event.ts, props.seconds)}</span>
                <span className="j-text">
                    {event.room ? <span className="j-room">{event.room} · </span> : null}
                    {event.name || event.id} <b>{formatValue(event)}</b>
                    <span className="j-src"> ({formatSource(event)})</span>
                </span>
            </div>,
        );
    });

    return (
        <Box
            sx={LIST_SX}
            onClick={e => {
                // one handler for all lines
                const line = (e.target as HTMLElement).closest<HTMLElement>('.j-line');
                if (line?.dataset.ts) {
                    onSelect(Number(line.dataset.ts));
                }
            }}
        >
            {lines}
            {props.more ? <div className="j-more">{I18n.t('Older changes are not shown.')}</div> : null}
        </Box>
    );
}

/** Renders again only if the events, the format or the handler change */
export const Journal = React.memo(JournalList);
