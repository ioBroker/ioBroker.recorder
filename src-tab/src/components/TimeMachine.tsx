import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    Box,
    FormControlLabel,
    IconButton,
    MenuItem,
    Paper,
    Select,
    Switch,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    KeyboardArrowLeft,
    KeyboardArrowRight,
    KeyboardDoubleArrowLeft,
    KeyboardDoubleArrowRight,
    Pause,
    PlayArrow,
    Update,
} from '@mui/icons-material';
import { I18n } from '@iobroker/gui-components';

import type { JournalEntry, RecorderApi, SnapshotEntry, TimelineAnswer } from '../api';
import {
    CATEGORY_LABELS,
    categoryOrder,
    compareText,
    DAY,
    formatDate,
    formatTime,
    HOUR,
    MINUTE,
    SECOND,
    toLocalInput,
} from '../format';
import { Journal } from './Journal';
import { RoomTiles } from './RoomTiles';
import { Timeline } from './Timeline';

const SPANS = [
    { label: '1h', ms: HOUR },
    { label: '6h', ms: 6 * HOUR },
    { label: '24h', ms: DAY },
    { label: '7d', ms: 7 * DAY },
    { label: '30d', ms: 30 * DAY },
];
const SPEEDS = [1, 10, 60, 600, 3600];
/** Real time between two steps of the playback */
const TICK = 500;
/** The journal shows the changes of this period before the cursor */
const JOURNAL_SPAN = 6 * HOUR;
const JOURNAL_LIMIT = 300;
/** Playback: a full snapshot every this many steps, for the 5 minute values */
const SNAPSHOT_EVERY = 20;
const BUCKETS = 240;

interface Filters {
    room: string;
    category: string;
    manualOnly: boolean;
}

function inRoom(entry: { room: string | null }, room: string): boolean {
    return (entry.room || '')
        .split(',')
        .map(r => r.trim())
        .includes(room);
}

/** True if a change belongs into the journal with the filters */
function matches(event: JournalEntry, filters: Filters): boolean {
    return (
        (!filters.room || inRoom(event, filters.room)) &&
        (!filters.category || event.category === filters.category) &&
        (!filters.manualOnly || event.src === 'user')
    );
}

/** Applies changes to the states of a snapshot (playback) */
function applyEvents(states: SnapshotEntry[], events: JournalEntry[]): SnapshotEntry[] {
    if (!events.length) {
        return states;
    }
    const byId = new Map(states.map(s => [s.id, s]));
    for (const e of events) {
        const previous = byId.get(e.id);
        byId.set(e.id, {
            id: e.id,
            name: e.name,
            room: e.room,
            func: previous?.func ?? null,
            category: e.category,
            role: e.role,
            unit: e.unit,
            val: e.val,
            text: e.text,
            lc: e.ts,
            ack: e.ack,
            from: e.from,
            user: e.user,
            c: e.c,
            src: e.src,
        });
    }
    return [...byId.values()];
}

/** "now", "5 min ago", "3 h ago", "2 days ago" */
function relative(ts: number, now: number): string {
    const diff = now - ts;
    if (diff < MINUTE) {
        return I18n.t('now');
    }
    if (diff < HOUR) {
        return I18n.t('%s min ago', Math.round(diff / MINUTE));
    }
    if (diff < 2 * DAY) {
        return I18n.t('%s h ago', Math.round(diff / HOUR));
    }
    return I18n.t('%s days ago', Math.round(diff / DAY));
}

/**
 * Walk into the past: the timeline with the density of the changes, the state of every room at the
 * cursor and the journal of the changes before it. Playing moves the cursor and applies only the
 * changes since the last step.
 */
export function TimeMachine(props: { api: RecorderApi }): React.JSX.Element {
    const { api } = props;
    const [now, setNow] = useState(() => Date.now());
    const [cursor, setCursor] = useState(() => Date.now());
    const [span, setSpan] = useState(DAY);
    const [windowEnd, setWindowEnd] = useState(() => Date.now());
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(60);
    const [filters, setFilters] = useState<Filters>({ room: '', category: '', manualOnly: false });
    const [search, setSearch] = useState('');
    const [states, setStates] = useState<SnapshotEntry[]>([]);
    const [keyframe, setKeyframe] = useState<number | null>(null);
    const [journal, setJournal] = useState<{ events: JournalEntry[]; more: boolean }>({ events: [], more: false });
    const [timeline, setTimeline] = useState<TimelineAnswer | null>(null);
    const [error, setError] = useState('');
    const [alive, setAlive] = useState(true);
    /** Time from the request of a snapshot until it is drawn */
    const [timing, setTiming] = useState<{ ms: number; server: number } | null>(null);

    const cursorRef = useRef(cursor);
    const speedRef = useRef(speed);
    const filtersRef = useRef(filters);
    const snapshotSeq = useRef(0);
    const journalSeq = useRef(0);
    const busy = useRef(false);
    const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const journalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSnapshotLoad = useRef(0);
    const pendingTiming = useRef<{ started: number; server: number } | null>(null);
    const spanRef = useRef(span);
    const nowRef = useRef(now);

    // the refs are read by timers and callbacks; these effects run before the ones below
    useEffect(() => {
        speedRef.current = speed;
    }, [speed]);
    useEffect(() => {
        filtersRef.current = filters;
    }, [filters]);
    useEffect(() => {
        spanRef.current = span;
    }, [span]);

    /** Moves the window of the timeline if the cursor left it */
    const follow = useCallback((ts: number): void => {
        setWindowEnd(end =>
            ts > end || ts < end - spanRef.current ? Math.min(Date.now(), ts + spanRef.current / 2) : end,
        );
    }, []);

    const loadSnapshot = useCallback(
        async (ts: number): Promise<void> => {
            const seq = ++snapshotSeq.current;
            const started = performance.now();
            lastSnapshotLoad.current = Date.now();
            try {
                const answer = await api.snapshot({ ts });
                if (seq !== snapshotSeq.current) {
                    return;
                }
                pendingTiming.current = { started, server: answer.ms };
                setStates(answer.states);
                setKeyframe(answer.keyframe);
                setError('');
            } catch (e) {
                if (seq === snapshotSeq.current) {
                    setError(String((e as Error).message || e));
                }
            }
        },
        [api],
    );

    const loadJournal = useCallback(
        async (ts: number): Promise<void> => {
            const seq = ++journalSeq.current;
            const f = filtersRef.current;
            try {
                const answer = await api.events({
                    start: ts - JOURNAL_SPAN,
                    end: ts,
                    newest: true,
                    limit: JOURNAL_LIMIT,
                    room: f.room || undefined,
                    category: f.category || undefined,
                    src: f.manualOnly ? 'user' : undefined,
                });
                if (seq === journalSeq.current) {
                    setJournal({ events: answer.events.reverse(), more: answer.more });
                }
            } catch (e) {
                if (seq === journalSeq.current) {
                    setError(String((e as Error).message || e));
                }
            }
        },
        [api],
    );

    /** Moves the cursor; while dragging the snapshot is loaded at most every 150 ms */
    const jump = useCallback(
        (ts: number, final = true): void => {
            const target = Math.min(Math.round(ts), Date.now());
            cursorRef.current = target;
            setCursor(target);
            follow(target);
            if (snapshotTimer.current) {
                clearTimeout(snapshotTimer.current);
            }
            const wait = final ? 0 : Math.max(0, 150 - (Date.now() - lastSnapshotLoad.current));
            snapshotTimer.current = setTimeout(() => void loadSnapshot(cursorRef.current), wait);
            if (journalTimer.current) {
                clearTimeout(journalTimer.current);
            }
            journalTimer.current = setTimeout(() => void loadJournal(cursorRef.current), final ? 0 : 300);
        },
        [loadSnapshot, loadJournal, follow],
    );

    // the first snapshot, and whether the instance runs
    useEffect(() => {
        void api.isAlive().then(setAlive);
        void loadSnapshot(cursorRef.current);
        void loadJournal(cursorRef.current);
        return () => {
            if (snapshotTimer.current) {
                clearTimeout(snapshotTimer.current);
            }
            if (journalTimer.current) {
                clearTimeout(journalTimer.current);
            }
        };
    }, [api, loadSnapshot, loadJournal]);

    // the time of a jump until the new states are in the DOM (the acceptance of milestone 4: below
    // 300 ms). Measured at the commit, not at the next frame: a browser throttles the frames of a
    // window in the background, which would add up to a quarter of a second.
    useLayoutEffect(() => {
        const pending = pendingTiming.current;
        if (pending) {
            pendingTiming.current = null;
            const ms = Math.round(performance.now() - pending.started);
            queueMicrotask(() => setTiming({ ms, server: pending.server }));
        }
    }, [states]);

    // the present moves on; a window that shows the present follows it
    useEffect(() => {
        const timer = setInterval(() => {
            const current = Date.now();
            const previous = nowRef.current;
            nowRef.current = current;
            setNow(current);
            setWindowEnd(end => (end >= previous - SECOND ? current : end));
        }, 30 * SECOND);
        return () => clearInterval(timer);
    }, []);

    // the density on the timeline
    useEffect(() => {
        let cancelled = false;
        api.timeline({
            start: windowEnd - span,
            end: windowEnd,
            buckets: BUCKETS,
            room: filters.room || undefined,
            category: filters.category || undefined,
            src: filters.manualOnly ? 'user' : undefined,
        })
            .then(answer => !cancelled && setTimeline(answer))
            .catch((e: unknown) => !cancelled && setError(String((e as Error).message || e)));
        return () => {
            cancelled = true;
        };
    }, [api, windowEnd, span, filters]);

    // other filters: the journal again
    useEffect(() => {
        void loadJournal(cursorRef.current);
    }, [filters, loadJournal]);

    // playback: per step only the changes since the last step
    useEffect(() => {
        if (!playing) {
            return undefined;
        }
        let steps = 0;
        const timer = setInterval(() => {
            if (busy.current) {
                return;
            }
            busy.current = true;
            const from = cursorRef.current;
            const to = Math.min(from + speedRef.current * TICK, Date.now());
            steps++;
            const step = async (): Promise<void> => {
                const answer = await api.events({ start: from + 1, end: to, limit: 2000 });
                if (cursorRef.current !== from) {
                    // the user jumped meanwhile
                    return;
                }
                cursorRef.current = to;
                setCursor(to);
                follow(to);
                if (answer.more || steps % SNAPSHOT_EVERY === 0) {
                    // too many changes to apply, or time for the 5 minute values: a full snapshot
                    await loadSnapshot(to);
                } else {
                    setStates(previous => applyEvents(previous, answer.events));
                }
                if (answer.more) {
                    await loadJournal(to);
                } else {
                    const added = answer.events.filter(e => matches(e, filtersRef.current)).reverse();
                    if (added.length) {
                        setJournal(previous => ({
                            events: added.concat(previous.events).slice(0, JOURNAL_LIMIT),
                            more: previous.more || added.length + previous.events.length > JOURNAL_LIMIT,
                        }));
                    }
                }
                if (to >= Date.now() - SECOND) {
                    setPlaying(false);
                }
            };
            step()
                .catch((e: unknown) => {
                    setError(String((e as Error).message || e));
                    setPlaying(false);
                })
                .finally(() => {
                    busy.current = false;
                });
        }, TICK);
        return () => clearInterval(timer);
    }, [playing, api, loadSnapshot, loadJournal, follow]);

    const rooms = useMemo(() => {
        const names = new Set<string>();
        for (const s of states) {
            for (const r of (s.room || '').split(',')) {
                if (r.trim()) {
                    names.add(r.trim());
                }
            }
        }
        return [...names].sort(compareText);
    }, [states]);
    const categories = useMemo(
        () =>
            [...new Set(states.map(s => s.category).filter((c): c is string => !!c))].sort(
                (a, b) => categoryOrder(a) - categoryOrder(b),
            ),
        [states],
    );
    const shown = useMemo(() => {
        const text = search.trim().toLowerCase();
        return states.filter(
            s =>
                (!filters.room || inRoom(s, filters.room)) &&
                (!filters.category || s.category === filters.category) &&
                (!text || (s.name || '').toLowerCase().includes(text) || s.id.toLowerCase().includes(text)),
        );
    }, [states, filters, search]);

    /** A click into the journal jumps to the change (stable for the memo of the journal) */
    const selectEvent = useCallback(
        (ts: number): void => {
            setPlaying(false);
            jump(ts);
        },
        [jump],
    );

    const first = timeline?.first ?? null;
    const start = windowEnd - span;
    const atPresent = now - cursor < MINUTE;
    const recent = playing ? Math.max(2 * MINUTE, speed * 4 * SECOND) : 5 * MINUTE;
    const move = (delta: number): void => jump(Math.max(first ?? 0, Math.min(cursorRef.current + delta, Date.now())));

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 1.5, gap: 1, overflow: 'hidden' }}>
            {/* time, controls */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ minWidth: 220 }}>
                    <Typography
                        variant="h5"
                        sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}
                    >
                        {formatTime(cursor, true)}
                    </Typography>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        {formatDate(cursor)} · {relative(cursor, now)}
                    </Typography>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <Tooltip title={I18n.t('1 hour back')}>
                        <IconButton onClick={() => move(-HOUR)}>
                            <KeyboardDoubleArrowLeft />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('5 minutes back')}>
                        <IconButton onClick={() => move(-5 * MINUTE)}>
                            <KeyboardArrowLeft />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={playing ? I18n.t('Pause') : I18n.t('Play')}>
                        <span>
                            <IconButton
                                color="primary"
                                size="large"
                                disabled={!playing && atPresent}
                                onClick={() => setPlaying(!playing)}
                            >
                                {playing ? <Pause fontSize="large" /> : <PlayArrow fontSize="large" />}
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title={I18n.t('5 minutes forward')}>
                        <IconButton onClick={() => move(5 * MINUTE)}>
                            <KeyboardArrowRight />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('1 hour forward')}>
                        <IconButton onClick={() => move(HOUR)}>
                            <KeyboardDoubleArrowRight />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t('Back to the present')}>
                        <IconButton
                            onClick={() => {
                                setPlaying(false);
                                jump(Date.now());
                            }}
                        >
                            <Update />
                        </IconButton>
                    </Tooltip>
                </Box>
                <Select
                    size="small"
                    value={speed}
                    onChange={e => setSpeed(Number(e.target.value))}
                    title={I18n.t('Speed')}
                >
                    {SPEEDS.map(s => (
                        <MenuItem
                            key={s}
                            value={s}
                        >
                            {s}×
                        </MenuItem>
                    ))}
                </Select>
                <TextField
                    size="small"
                    type="datetime-local"
                    label={I18n.t('Jump to')}
                    value={toLocalInput(cursor)}
                    slotProps={{ inputLabel: { shrink: true } }}
                    onChange={e => {
                        const ts = new Date(e.target.value).getTime();
                        if (Number.isFinite(ts)) {
                            jump(ts);
                        }
                    }}
                />
                <Box sx={{ flexGrow: 1 }} />
                <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={span}
                    onChange={(_e, value: number | null) => {
                        if (value) {
                            setSpan(value);
                            spanRef.current = value;
                            follow(cursorRef.current);
                        }
                    }}
                >
                    {SPANS.map(s => (
                        <ToggleButton
                            key={s.label}
                            value={s.ms}
                        >
                            {I18n.t(s.label)}
                        </ToggleButton>
                    ))}
                </ToggleButtonGroup>
            </Box>

            <Timeline
                start={timeline && timeline.start === start ? timeline.start : start}
                end={windowEnd}
                counts={timeline && timeline.start === start ? timeline.counts : []}
                step={timeline && timeline.start === start ? timeline.step : Math.ceil(span / BUCKETS)}
                cursor={cursor}
                first={first}
                now={now}
                onSeek={(ts, final) => jump(ts, final)}
            />

            {/* filters and status */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5 }}>
                <Select
                    size="small"
                    displayEmpty
                    value={filters.room}
                    onChange={e => setFilters({ ...filters, room: e.target.value })}
                    sx={{ minWidth: 160 }}
                >
                    <MenuItem value="">{I18n.t('All rooms')}</MenuItem>
                    {rooms.map(r => (
                        <MenuItem
                            key={r}
                            value={r}
                        >
                            {r}
                        </MenuItem>
                    ))}
                </Select>
                <Select
                    size="small"
                    displayEmpty
                    value={filters.category}
                    onChange={e => setFilters({ ...filters, category: e.target.value })}
                    sx={{ minWidth: 160 }}
                >
                    <MenuItem value="">{I18n.t('All categories')}</MenuItem>
                    {categories.map(c => (
                        <MenuItem
                            key={c}
                            value={c}
                        >
                            {CATEGORY_LABELS[c] ? I18n.t(CATEGORY_LABELS[c]) : c}
                        </MenuItem>
                    ))}
                </Select>
                <FormControlLabel
                    control={
                        <Switch
                            checked={filters.manualOnly}
                            onChange={e => setFilters({ ...filters, manualOnly: e.target.checked })}
                        />
                    }
                    label={I18n.t('Manual actions only')}
                />
                <TextField
                    size="small"
                    placeholder={I18n.t('Search')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <Box sx={{ flexGrow: 1 }} />
                <Typography
                    variant="caption"
                    color="text.secondary"
                    title={keyframe ? I18n.t('Keyframe %s', formatTime(keyframe)) : undefined}
                >
                    {I18n.t('%s states', shown.length)}
                    {timing ? ` · ${I18n.t('jump in %s ms (server %s ms)', timing.ms, timing.server)}` : ''}
                </Typography>
            </Box>

            {!alive ? <Alert severity="warning">{I18n.t('The instance is not running.')}</Alert> : null}
            {error ? (
                <Alert
                    severity="error"
                    onClose={() => setError('')}
                >
                    {error}
                </Alert>
            ) : null}

            {/* rooms and journal */}
            <Box
                sx={{
                    flexGrow: 1,
                    minHeight: 0,
                    display: 'flex',
                    gap: 1.5,
                    flexDirection: { xs: 'column', md: 'row' },
                }}
            >
                <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
                    <RoomTiles
                        states={shown}
                        cursor={cursor}
                        recent={recent}
                    />
                </Box>
                <Paper
                    variant="outlined"
                    sx={{
                        width: { xs: '100%', md: 380 },
                        flexShrink: 0,
                        minHeight: 0,
                        maxHeight: { xs: '40%', md: '100%' },
                        overflow: 'auto',
                    }}
                >
                    <Typography
                        variant="subtitle2"
                        sx={{ px: 1, pt: 1, fontWeight: 600 }}
                    >
                        {I18n.t('Journal')}
                    </Typography>
                    <Journal
                        events={journal.events}
                        more={journal.more}
                        seconds={span <= HOUR}
                        onSelect={selectEvent}
                    />
                </Paper>
            </Box>
        </Box>
    );
}
