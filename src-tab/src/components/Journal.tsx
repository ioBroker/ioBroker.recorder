import React from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import { I18n } from '@iobroker/gui-components';

import type { JournalEntry } from '../api';
import { formatSource, formatTime, formatValue } from '../format';

interface JournalProps {
    /** Newest first */
    events: JournalEntry[];
    /** There were more events in the period than loaded */
    more: boolean;
    seconds: boolean;
    onSelect: (ts: number) => void;
}

/** The changes before the cursor: "07:12 Bad · Licht an (admin, vis-2.0)" */
export function Journal(props: JournalProps): React.JSX.Element {
    const theme = useTheme();
    if (!props.events.length) {
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
    const days = props.events.map(event => new Date(event.ts).toDateString());
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            {props.events.map((event, i) => {
                // a line with the date where the day changes
                const showDay = i > 0 && days[i] !== days[i - 1];
                const manual = event.src === 'user';
                return (
                    <React.Fragment key={`${event.ts}-${event.id}-${i}`}>
                        {showDay ? (
                            <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ px: 1, pt: 1, borderTop: `1px solid ${theme.palette.divider}` }}
                            >
                                {new Date(event.ts).toLocaleDateString(undefined, {
                                    weekday: 'long',
                                    day: '2-digit',
                                    month: '2-digit',
                                })}
                            </Typography>
                        ) : null}
                        <Box
                            onClick={() => props.onSelect(event.ts)}
                            title={event.id}
                            sx={{
                                display: 'grid',
                                gridTemplateColumns: 'auto 1fr',
                                columnGap: 1,
                                px: 1,
                                py: 0.5,
                                cursor: 'pointer',
                                borderLeft: `3px solid ${manual ? theme.palette.secondary.main : 'transparent'}`,
                                '&:hover': { bgcolor: theme.palette.action.hover },
                            }}
                        >
                            <Typography
                                variant="body2"
                                sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}
                            >
                                {formatTime(event.ts, props.seconds)}
                            </Typography>
                            <Typography
                                variant="body2"
                                sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                            >
                                {event.room ? <span style={{ opacity: 0.7 }}>{event.room} · </span> : null}
                                {event.name || event.id} <b>{formatValue(event)}</b>
                                <span style={{ opacity: 0.6 }}> ({formatSource(event)})</span>
                            </Typography>
                        </Box>
                    </React.Fragment>
                );
            })}
            {props.more ? (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ p: 1 }}
                >
                    {I18n.t('Older changes are not shown.')}
                </Typography>
            ) : null}
        </Box>
    );
}
