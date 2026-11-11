import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { BurndownDay, BurndownPage } from '../api/types';
import { dayCounts, holdsTasks, isRecorded, niceCeil, openChange, weekTicks } from '../lib/burndown';
import { calendarDay, dayLabel } from '../lib/dates';
import { formatInt } from '../lib/format';
import { cn } from '../lib/utils';

/** The open tasks panel's height, in px. */
const LINE_HEIGHT = 112;
/** Each half of the created and closed panel, in px: created above its middle line, closed below. */
const FLOW_HALF = 36;
/** The space between the two panels, in px: room for the tick words that sit centred on each panel's edge. */
const PANEL_GAP = 20;
/** The fewest days a not-recorded stretch spans before it carries its words; a shorter one says them on hover. */
const GAP_LABEL_DAYS = 8;

/**
 * The open tasks of the last eight weeks: a line of the tasks open at each
 * day's end, over each day's tasks created (above a middle line) and closed
 * (below it, done in green, then closed some other way). Pointing at a day,
 * or moving through the days with the arrow keys, shows its counts. A day
 * nothing was recorded by is a band in Surface that says Not recorded; it is
 * never drawn as zero.
 */
export function BurndownChart({ page, nowMs, zone }: { page: BurndownPage; nowMs: number; zone: string }) {
  const titleId = useId();
  const days = page.days;
  const n = days.length;
  const [pointed, setPointed] = useState<number | null>(null);
  const first = days.findIndex(isRecorded);

  const header = (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={titleId} className="text-label font-semibold text-ink">
        Open tasks
      </h2>
      <span className="text-meta text-ink-3">Last 8 weeks</span>
    </div>
  );
  if (first === -1 || !holdsTasks(days)) {
    return (
      <section aria-labelledby={titleId} className="flex flex-col gap-2 px-6 py-4 max-sm:px-4" data-burndown="">
        {header}
        <p className="text-meta text-ink-3" data-burndown-empty="">
          No tasks in the last 8 weeks
        </p>
      </section>
    );
  }

  const recorded = days.filter(isRecorded);
  const openMax = 2 * niceCeil(Math.max(...recorded.map((day) => day.open)) / 2);
  const flowMax = niceCeil(Math.max(...recorded.map((day) => Math.max(day.created, day.done + day.closedNotDone))));
  const today = days.at(-1)!;
  const change = openChange(days);
  const x = (index: number) => `${((index + 0.5) / n) * 100}%`;
  const y = (open: number) => (1 - open / openMax) * 100;
  const points = days.flatMap((day, index) => (isRecorded(day) ? [`${index + 0.5},${y(day.open)}`] : []));
  const shown = pointed === null ? null : days[pointed]!;
  const flowHeight = (count: number) => (count === 0 ? 0 : Math.max(2, Math.round((count / flowMax) * FLOW_HALF)));

  function pointAt(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    setPointed(Math.min(n - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * n))));
  }
  function step(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, (at: number) => number> = {
      ArrowLeft: (at) => at - 1,
      ArrowRight: (at) => at + 1,
      Home: () => 0,
      End: () => n - 1,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setPointed((at) => Math.min(n - 1, Math.max(0, move(at ?? n - 1))));
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 px-6 py-4 max-sm:px-4" data-burndown="">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        {header}
        <Legend />
      </div>
      <p className="nums flex flex-wrap items-baseline gap-x-2 text-sm font-normal text-ink-2" data-burndown-summary="">
        <span>
          <b className="text-heading text-ink">{formatInt(isRecorded(today) ? today.open : 0)}</b> open
        </span>
        {change !== null ? (
          <span className="text-ink-3">
            {change.change === 0
              ? `Same as on ${calendarDay(change.since, nowMs, zone)}`
              : `${formatInt(Math.abs(change.change))} ${change.change < 0 ? 'fewer' : 'more'} than on ${calendarDay(change.since, nowMs, zone)}`}
          </span>
        ) : null}
      </p>
      <p className="nums min-h-4 text-meta text-ink-3" aria-live="polite" data-burndown-readout="">
        {shown === null
          ? isRecorded(today)
            ? `Today: ${formatInt(today.created)} created, ${formatInt(today.done)} done`
            : null
          : `${dayLabel(shown.day)}: ${isRecorded(shown) ? dayCounts(shown) : 'Not recorded'}`}
      </p>
      <div className="flex">
        <div aria-hidden className="nums relative w-10 shrink-0 text-meta text-ink-3 max-sm:w-8">
          <div className="relative" style={{ height: LINE_HEIGHT }}>
            <Tick at={0}>{formatInt(openMax)}</Tick>
            <Tick at={50}>{formatInt(openMax / 2)}</Tick>
            <Tick at={100}>0</Tick>
          </div>
          <div className="relative" style={{ marginTop: PANEL_GAP, height: 2 * FLOW_HALF + 1 }}>
            <Tick at={0}>{`+${formatInt(flowMax)}`}</Tick>
            <Tick at={50}>0</Tick>
            <Tick at={100}>{`−${formatInt(flowMax)}`}</Tick>
          </div>
        </div>
        <div
          role="group"
          aria-labelledby={titleId}
          tabIndex={0}
          className="relative min-w-0 flex-1 touch-pan-y rounded-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onPointerMove={pointAt}
          onPointerDown={pointAt}
          onPointerLeave={() => setPointed(null)}
          onKeyDown={step}
          onBlur={() => setPointed(null)}
          data-burndown-plot=""
        >
          {/* Behind the marks: the days not recorded, and the day pointed at. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0"
            style={{ height: LINE_HEIGHT + PANEL_GAP + 2 * FLOW_HALF + 1 }}
          >
            {first > 0 ? (
              <div
                className="absolute inset-y-0 left-0 flex items-center justify-center bg-surface"
                style={{ width: `${(first / n) * 100}%` }}
                data-burndown-gap={first}
              >
                {first >= GAP_LABEL_DAYS ? <span className="text-meta text-ink-3">Not recorded</span> : null}
              </div>
            ) : null}
            {pointed !== null ? (
              <div
                className="absolute inset-y-0 bg-hover"
                style={{ left: `${(pointed / n) * 100}%`, width: `${100 / n}%` }}
              />
            ) : null}
          </div>
          <div aria-hidden className="relative" style={{ height: LINE_HEIGHT }}>
            {[0, 50, 100].map((at) => (
              <div key={at} className="absolute inset-x-0 border-t border-border" style={{ top: `${at}%` }} />
            ))}
            <svg
              className="absolute inset-0 size-full overflow-visible text-ink"
              viewBox={`0 0 ${n} 100`}
              preserveAspectRatio="none"
            >
              <polygon
                points={`${first + 0.5},100 ${points.join(' ')} ${n - 0.5},100`}
                fill="currentColor"
                fillOpacity={0.08}
              />
              <polyline
                points={points.join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {isRecorded(days[pointed ?? n - 1]!) ? (
              <span
                className="absolute size-2 -translate-1/2 rounded-full bg-ink ring-2 ring-background"
                style={{ left: x(pointed ?? n - 1), top: `${y(days[pointed ?? n - 1]!.open!)}%` }}
                data-burndown-dot=""
              />
            ) : null}
          </div>
          <div aria-hidden className="relative flex" style={{ marginTop: PANEL_GAP, height: 2 * FLOW_HALF + 1 }}>
            <div className="absolute inset-x-0 h-px bg-border-strong" style={{ top: FLOW_HALF }} />
            {days.map((day) => (
              <div key={day.day} className="relative flex-1" data-burndown-day={day.day}>
                {isRecorded(day) ? <Flow day={day} height={flowHeight} /> : null}
              </div>
            ))}
          </div>
          <div aria-hidden className="relative mt-1.5 h-4 text-meta text-ink-3">
            {weekTicks(days).map((index, k, all) => (
              <span
                key={index}
                className={cn(
                  'absolute whitespace-nowrap',
                  index === n - 1 ? 'right-0' : '-translate-x-1/2',
                  (all.length - 1 - k) % 2 === 1 && 'max-sm:hidden',
                )}
                style={index === n - 1 ? undefined : { left: x(index) }}
              >
                {calendarDay(days[index]!.day, nowMs, zone)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <BurndownTable days={days} />
    </section>
  );
}

/** A tick's words in the gutter, centred on its line, `at` percent down. */
function Tick({ at, children }: { at: number; children: string }) {
  return (
    <span className="absolute right-2 -translate-y-1/2 whitespace-nowrap max-sm:right-1.5" style={{ top: `${at}%` }}>
      {children}
    </span>
  );
}

/** One day's bars: created above the middle line, and below it done, then closed some other way. */
function Flow({
  day,
  height,
}: {
  day: { created: number; done: number; closedNotDone: number };
  height: (count: number) => number;
}) {
  const created = height(day.created);
  const done = height(day.done);
  const other = height(day.closedNotDone);
  const bar = 'absolute inset-x-[20%] max-sm:inset-x-[10%]';
  return (
    <>
      {created > 0 ? (
        <span className={cn(bar, 'rounded-t-[2px] bg-ink-3')} style={{ bottom: FLOW_HALF + 1, height: created }} />
      ) : null}
      {done > 0 ? (
        <span
          className={cn(bar, 'bg-done', other === 0 && 'rounded-b-[2px]')}
          style={{ top: FLOW_HALF + 1, height: done }}
        />
      ) : null}
      {other > 0 ? (
        <span
          className={cn(bar, 'rounded-b-[2px] bg-ink-3/60')}
          style={{ top: FLOW_HALF + 1 + (done > 0 ? done + 2 : 0), height: other }}
        />
      ) : null}
    </>
  );
}

/** The key beside the title: the open line and the three kinds of bar. */
function Legend() {
  const items = [
    { label: 'Open', mark: 'h-0.5 w-3 rounded-full bg-ink' },
    { label: 'Created', mark: 'size-2.25 rounded-xs bg-ink-3' },
    { label: 'Done', mark: 'size-2.25 rounded-xs bg-done' },
    { label: 'Closed, not done', mark: 'size-2.25 rounded-xs bg-ink-3/60' },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-meta text-ink-2" aria-label="Key">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn('shrink-0', item.mark)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Every day's counts as a table, for a screen reader: the chart's values without pointing at them.
 * The wrapper is what hides it: a table grows to fit its cells whatever width it is given, so a
 * hidden table on its own widens the page on a phone.
 */
function BurndownTable({ days }: { days: readonly BurndownDay[] }) {
  return (
    <div className="sr-only">
      <table data-burndown-table="">
        <caption>Open tasks by day, last 8 weeks</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Open</th>
            <th scope="col">Created</th>
            <th scope="col">Done</th>
            <th scope="col">Closed, not done</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{dayLabel(day.day)}</th>
              {isRecorded(day) ? (
                <>
                  <td>{formatInt(day.open)}</td>
                  <td>{formatInt(day.created)}</td>
                  <td>{formatInt(day.done)}</td>
                  <td>{formatInt(day.closedNotDone)}</td>
                </>
              ) : (
                <td colSpan={4}>Not recorded</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
