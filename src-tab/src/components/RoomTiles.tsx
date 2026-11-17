import React, { useMemo, useState } from 'react';
import { Box, Button, Paper, Typography, type Theme } from '@mui/material';
import {
    Blinds,
    Bolt,
    DirectionsRun,
    Lightbulb,
    MusicNote,
    Power,
    Security,
    Sensors,
    Thermostat,
    WbSunny,
    Window,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import type { SnapshotEntry } from '../api';
import { CATEGORY_LABELS, categoryOrder, compareText, formatShort, formatValue, isActive } from '../format';

const ICONS: Record<string, React.ComponentType<{ className?: string; fontSize?: 'small' }>> = {
    light: Lightbulb,
    shading: Blinds,
    climate: Thermostat,
    windowsDoors: Window,
    motion: DirectionsRun,
    security: Security,
    sockets: Power,
    media: MusicNote,
    weather: WbSunny,
    energy: Bolt,
};

/** Rows shown per room before "more" */
const ROWS = 14;

/**
 * The styles of all rows in one place: a few hundred rows with their own `sx`, tooltips and
 * typography components cost a quarter of a second per render, plain elements almost nothing.
 */
const GRID_SX = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 1.5,
    alignItems: 'start',
    '& .t-tile': { p: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 },
    '& .t-head': { display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 },
    '& .t-room': {
        typography: 'subtitle1',
        fontWeight: 600,
        flexGrow: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    '& .t-summary': { typography: 'caption', color: 'text.secondary', whiteSpace: 'nowrap' },
    '& .t-row': {
        typography: 'body2',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 0.5,
        py: 0.25,
        borderRadius: 1,
        transition: 'background-color 0.4s',
    },
    '& .t-changed': {
        bgcolor: (theme: Theme) =>
            theme.palette.mode === 'dark' ? 'rgba(255, 193, 7, 0.16)' : 'rgba(255, 193, 7, 0.25)',
    },
    '& .t-icon': { color: 'text.disabled' },
    '& .t-active .t-icon': { color: 'warning.main' },
    '& .t-active.t-light .t-icon': { color: '#f5b400' },
    '& .t-name': { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& .t-value': {
        maxWidth: '45%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
    },
    '& .t-active .t-value': { fontWeight: 600 },
} as const;

interface RoomTilesProps {
    states: SnapshotEntry[];
    cursor: number;
    /** A change within this time before the cursor is highlighted */
    recent: number;
}

interface Room {
    name: string;
    entries: SnapshotEntry[];
    lightsOn: number;
    lights: number;
    open: number;
    temperature: SnapshotEntry | null;
}

function roomsOf(states: SnapshotEntry[]): Room[] {
    const byRoom = new Map<string, SnapshotEntry[]>();
    for (const entry of states) {
        const name = entry.room || '';
        let list = byRoom.get(name);
        if (!list) {
            list = [];
            byRoom.set(name, list);
        }
        list.push(entry);
    }
    const rooms: Room[] = [];
    for (const [name, entries] of byRoom) {
        entries.sort(
            (a, b) =>
                categoryOrder(a.category) - categoryOrder(b.category) || compareText(a.name || a.id, b.name || b.id),
        );
        const lights = entries.filter(e => e.category === 'light' && typeof e.val !== 'string');
        rooms.push({
            name,
            entries,
            lights: lights.length,
            lightsOn: lights.filter(isActive).length,
            open: entries.filter(e => e.category === 'windowsDoors' && isActive(e)).length,
            // the temperature of a room; the states without room have none
            temperature:
                (name &&
                    entries.find(
                        e =>
                            e.category === 'climate' &&
                            typeof e.val === 'number' &&
                            (e.role || '').includes('temperature'),
                    )) ||
                null,
        });
    }
    // rooms by name, the states without room last
    return rooms.sort((a, b) => (!a.name ? 1 : !b.name ? -1 : compareText(a.name, b.name)));
}

function tooltip(entry: SnapshotEntry): string {
    const lines = [entry.id];
    const label = CATEGORY_LABELS[entry.category || ''];
    if (label) {
        lines.push(I18n.t(label));
    }
    if (entry.lc !== null) {
        lines.push(I18n.t('changed at %s', formatShort(entry.lc)));
    }
    if (entry.aggregated) {
        lines.push(I18n.t('5 minute value'));
    }
    return lines.join('\n');
}

interface TileProps {
    room: Room;
    /** IDs of the highlighted rows, joined: a tile renders again only if it changes */
    changed: string;
}

function TileView(props: TileProps): React.JSX.Element {
    const { room } = props;
    const [all, setAll] = useState(false);
    const changed = new Set(props.changed ? props.changed.split('\n') : []);
    const shown = all ? room.entries : room.entries.slice(0, ROWS);
    const summary: string[] = [];
    if (room.lights) {
        summary.push(I18n.t('%s of %s lights on', room.lightsOn, room.lights));
    }
    if (room.open) {
        summary.push(I18n.t('%s open', room.open));
    }
    if (room.temperature) {
        summary.push(formatValue(room.temperature));
    }

    return (
        <Paper
            variant="outlined"
            className="t-tile"
        >
            <div className="t-head">
                <span className="t-room">{room.name || I18n.t('Without room')}</span>
                <span className="t-summary">{summary.join(' · ')}</span>
            </div>
            {shown.map(entry => {
                const Icon = ICONS[entry.category || ''] || Sensors;
                let className = 't-row';
                if (isActive(entry)) {
                    className += entry.category === 'light' ? ' t-active t-light' : ' t-active';
                }
                if (changed.has(entry.id)) {
                    className += ' t-changed';
                }
                return (
                    <div
                        key={entry.id}
                        className={className}
                        title={tooltip(entry)}
                    >
                        <Icon
                            fontSize="small"
                            className="t-icon"
                        />
                        <span className="t-name">{entry.name || entry.id}</span>
                        <span className="t-value">{formatValue(entry)}</span>
                    </div>
                );
            })}
            {room.entries.length > ROWS ? (
                <Button
                    size="small"
                    onClick={() => setAll(!all)}
                    sx={{ alignSelf: 'flex-start' }}
                >
                    {all ? I18n.t('less') : I18n.t('%s more', room.entries.length - ROWS)}
                </Button>
            ) : null}
        </Paper>
    );
}

const Tile = React.memo(TileView);

/** One tile per room with the state of its lights, windows, climate, shading ... at the cursor */
function RoomTilesView(props: RoomTilesProps): React.JSX.Element {
    const { cursor, recent } = props;
    const rooms = useMemo(() => roomsOf(props.states), [props.states]);
    if (!rooms.length) {
        return (
            <Typography
                color="text.secondary"
                sx={{ p: 2 }}
            >
                {I18n.t('Nothing was recorded at this time.')}
            </Typography>
        );
    }
    return (
        <Box sx={GRID_SX}>
            {rooms.map(room => (
                <Tile
                    key={room.name}
                    room={room}
                    changed={room.entries
                        .filter(e => e.lc !== null && cursor - e.lc >= 0 && cursor - e.lc < recent)
                        .map(e => e.id)
                        .join('\n')}
                />
            ))}
        </Box>
    );
}

export const RoomTiles = React.memo(RoomTilesView);
