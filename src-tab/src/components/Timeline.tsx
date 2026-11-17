import React, { useEffect, useRef, useState } from 'react';
import { Box, useTheme } from '@mui/material';

import { DAY, formatShort, formatTime, ticks, tickInterval } from '../format';

interface TimelineProps {
    start: number;
    end: number;
    /** Changes per interval of `step` ms from `start` */
    counts: number[];
    step: number;
    cursor: number;
    /** The oldest recorded time; before it there is nothing */
    first: number | null;
    now: number;
    /** While the pointer is pressed, `final` is false */
    onSeek: (ts: number, final: boolean) => void;
}

const HEIGHT = 84;
const AXIS = 18;

/**
 * The timeline of the admin tab: the density of the changes as bars, the cursor, and the time
 * axis. Clicking or dragging moves the cursor; the arrow keys step by one interval.
 */
export function Timeline(props: TimelineProps): React.JSX.Element {
    const { start, end, counts, step, cursor, first, now, onSeek } = props;
    const theme = useTheme();
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(800);
    const dragging = useRef(false);

    useEffect(() => {
        const element = ref.current;
        if (!element) {
            return undefined;
        }
        const observer = new ResizeObserver(entries => {
            setWidth(Math.max(200, Math.round(entries[0].contentRect.width)));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const span = Math.max(1, end - start);
    const x = (ts: number): number => ((ts - start) / span) * width;
    const timeAt = (clientX: number): number => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) {
            return cursor;
        }
        const ts = start + ((clientX - rect.left) / rect.width) * span;
        return Math.round(Math.min(Math.max(ts, first ?? start, start), Math.min(end, now)));
    };

    const max = Math.max(1, ...counts);
    const barHeight = HEIGHT - AXIS - 6;
    const tickStep = tickInterval(span, Math.max(2, Math.floor(width / 90)));
    const labelOf = (ts: number): string => (tickStep >= DAY ? formatShort(ts).split(' ')[0] : formatTime(ts));
    const dark = theme.palette.mode === 'dark';
    const unavailable = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

    return (
        <Box
            ref={ref}
            tabIndex={0}
            role="slider"
            aria-valuemin={start}
            aria-valuemax={end}
            aria-valuenow={cursor}
            aria-valuetext={formatShort(cursor)}
            sx={{
                position: 'relative',
                width: '100%',
                height: HEIGHT,
                cursor: 'ew-resize',
                userSelect: 'none',
                touchAction: 'none',
                outline: 'none',
                borderRadius: 1,
                bgcolor: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                '&:focus-visible': { boxShadow: `0 0 0 2px ${theme.palette.primary.main}` },
            }}
            onPointerDown={e => {
                dragging.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                onSeek(timeAt(e.clientX), false);
            }}
            onPointerMove={e => {
                if (dragging.current) {
                    onSeek(timeAt(e.clientX), false);
                }
            }}
            onPointerUp={e => {
                if (dragging.current) {
                    dragging.current = false;
                    onSeek(timeAt(e.clientX), true);
                }
            }}
            onKeyDown={e => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? step * 10 : step);
                    onSeek(Math.min(Math.max(cursor + delta, first ?? start), now), true);
                }
            }}
        >
            <svg
                width={width}
                height={HEIGHT}
                style={{ display: 'block' }}
            >
                {/* nothing recorded yet, and the future */}
                {first !== null && first > start ? (
                    <rect
                        x={0}
                        y={0}
                        width={Math.min(width, x(first))}
                        height={HEIGHT - AXIS}
                        fill={unavailable}
                    />
                ) : null}
                {now < end ? (
                    <rect
                        x={Math.max(0, x(now))}
                        y={0}
                        width={width - Math.max(0, x(now))}
                        height={HEIGHT - AXIS}
                        fill={unavailable}
                    />
                ) : null}
                {counts.map((count, i) => {
                    if (!count) {
                        return null;
                    }
                    const x1 = x(start + i * step);
                    const x2 = x(start + (i + 1) * step);
                    // square root: a few changes in a quiet hour stay visible next to busy ones
                    const h = Math.max(2, Math.sqrt(count / max) * barHeight);
                    return (
                        <rect
                            key={i}
                            x={x1 + 0.5}
                            y={HEIGHT - AXIS - h}
                            width={Math.max(1, x2 - x1 - 1)}
                            height={h}
                            rx={1}
                            fill={theme.palette.primary.main}
                            opacity={0.55}
                        >
                            <title>{`${formatShort(start + i * step)}: ${count}`}</title>
                        </rect>
                    );
                })}
                <line
                    x1={0}
                    x2={width}
                    y1={HEIGHT - AXIS + 0.5}
                    y2={HEIGHT - AXIS + 0.5}
                    stroke={theme.palette.divider}
                />
                {ticks(start, end, tickStep).map(t => (
                    <g key={t}>
                        <line
                            x1={x(t)}
                            x2={x(t)}
                            y1={HEIGHT - AXIS}
                            y2={HEIGHT - AXIS + 4}
                            stroke={theme.palette.text.secondary}
                        />
                        <text
                            x={x(t)}
                            y={HEIGHT - 3}
                            fontSize={11}
                            textAnchor="middle"
                            fill={theme.palette.text.secondary}
                        >
                            {labelOf(t)}
                        </text>
                    </g>
                ))}
                {cursor >= start && cursor <= end ? (
                    <g>
                        <line
                            x1={x(cursor)}
                            x2={x(cursor)}
                            y1={0}
                            y2={HEIGHT - AXIS}
                            stroke={theme.palette.secondary.main}
                            strokeWidth={2}
                        />
                        <circle
                            cx={x(cursor)}
                            cy={4}
                            r={4}
                            fill={theme.palette.secondary.main}
                        />
                    </g>
                ) : null}
            </svg>
        </Box>
    );
}
