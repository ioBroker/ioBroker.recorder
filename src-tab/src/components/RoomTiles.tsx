import React, { useMemo, useState } from 'react';
import { Box, Button, Paper, Tooltip, Typography, useTheme } from '@mui/material';
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
import { CATEGORY_LABELS, categoryOrder, formatShort, formatValue, isActive } from '../format';

const ICONS: Record<string, React.ComponentType<{ sx?: object; fontSize?: 'small' }>> = {
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
                categoryOrder(a.category) - categoryOrder(b.category) || (a.name || a.id).localeCompare(b.name || b.id),
        );
        const lights = entries.filter(e => e.category === 'light' && typeof e.val !== 'string');
        rooms.push({
            name,
            entries,
            lights: lights.length,
            lightsOn: lights.filter(isActive).length,
            open: entries.filter(e => e.category === 'windowsDoors' && isActive(e)).length,
            temperature: entries.find(e => e.category === 'climate' && (e.role || '').includes('temperature')) || null,
        });
    }
    // rooms by name, the states without room last
    return rooms.sort((a, b) => (!a.name ? 1 : !b.name ? -1 : a.name.localeCompare(b.name)));
}

function Tile(props: { room: Room; cursor: number; recent: number }): React.JSX.Element {
    const { room, cursor, recent } = props;
    const theme = useTheme();
    const [all, setAll] = useState(false);
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
            sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}
        >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
                <Typography
                    variant="subtitle1"
                    sx={{ fontWeight: 600, flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    noWrap
                >
                    {room.name || I18n.t('Without room')}
                </Typography>
                <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                >
                    {summary.join(' · ')}
                </Typography>
            </Box>
            {shown.map(entry => {
                const Icon = ICONS[entry.category || ''] || Sensors;
                const active = isActive(entry);
                const changed = entry.lc !== null && cursor - entry.lc >= 0 && cursor - entry.lc < recent;
                return (
                    <Tooltip
                        key={entry.id}
                        placement="left"
                        title={
                            <span>
                                {entry.id}
                                <br />
                                {CATEGORY_LABELS[entry.category || '']
                                    ? I18n.t(CATEGORY_LABELS[entry.category || ''])
                                    : ''}
                                {entry.lc !== null ? (
                                    <>
                                        <br />
                                        {I18n.t('changed at %s', formatShort(entry.lc))}
                                    </>
                                ) : null}
                                {entry.aggregated ? (
                                    <>
                                        <br />
                                        {I18n.t('5 minute value')}
                                    </>
                                ) : null}
                            </span>
                        }
                    >
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1,
                                px: 0.5,
                                py: 0.25,
                                borderRadius: 1,
                                transition: 'background-color 0.4s',
                                bgcolor: changed
                                    ? theme.palette.mode === 'dark'
                                        ? 'rgba(255, 193, 7, 0.16)'
                                        : 'rgba(255, 193, 7, 0.25)'
                                    : 'transparent',
                            }}
                        >
                            <Icon
                                fontSize="small"
                                sx={{
                                    color: active
                                        ? entry.category === 'light'
                                            ? '#f5b400'
                                            : theme.palette.warning.main
                                        : theme.palette.text.disabled,
                                }}
                            />
                            <Typography
                                variant="body2"
                                noWrap
                                sx={{ flexGrow: 1, minWidth: 0 }}
                            >
                                {entry.name || entry.id}
                            </Typography>
                            <Typography
                                variant="body2"
                                noWrap
                                sx={{
                                    fontWeight: active ? 600 : 400,
                                    fontVariantNumeric: 'tabular-nums',
                                    maxWidth: '45%',
                                }}
                            >
                                {formatValue(entry)}
                            </Typography>
                        </Box>
                    </Tooltip>
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

/** One tile per room with the state of its lights, windows, climate, shading ... at the cursor */
export function RoomTiles(props: RoomTilesProps): React.JSX.Element {
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
        <Box
            sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: 1.5,
                alignItems: 'start',
            }}
        >
            {rooms.map(room => (
                <Tile
                    key={room.name}
                    room={room}
                    cursor={props.cursor}
                    recent={props.recent}
                />
            ))}
        </Box>
    );
}
