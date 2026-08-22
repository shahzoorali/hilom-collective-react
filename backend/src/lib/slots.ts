/**
 * Turns a facilitator's recurring weekly availability into concrete bookable
 * instants.
 *
 * This module is deliberately pure — no Supabase, no clock, no environment.
 * `now` is a parameter rather than a `new Date()` call precisely so that the
 * min-notice and max-advance boundaries can be tested without freezing time
 * globally, and so that the two call sites (the public availability endpoint
 * and the create-booking handler) provably compute the same answer from the
 * same inputs.
 *
 * That second call site is the important one. The browser is never trusted with
 * the slot it picked: `POST /bookings` re-runs this function server-side and
 * rejects anything it does not produce. Otherwise a hand-crafted request could
 * book 3am, or a slot inside a blackout, or one that ignores the notice period.
 *
 * ## Timezones
 *
 * Availability is stored as (weekday, minutes-from-local-midnight) because the
 * rule is genuinely recurring — "Mondays 9-12" is one row forever. Projecting
 * those rules onto real instants is the only place the facilitator's timezone
 * matters; everything downstream is UTC. The projection is done with
 * `Intl.DateTimeFormat`, which is built into Node and knows the IANA database,
 * rather than by adding a date library for one function.
 *
 * Asia/Manila (the default, and where every facilitator is expected to be) has
 * no DST, so the offset arithmetic below is exact for it by construction. The
 * two-pass refinement exists for the facilitator who is not in Manila: on a DST
 * transition day a single pass can land on the wrong side of the jump.
 */

export interface AvailabilityWindow {
  /** 0 = Sunday, matching `Date#getUTCDay` and the DB check constraint. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface TimeRange {
  startsAt: string | Date;
  endsAt: string | Date;
}

export interface SlotServiceRules {
  durationMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  /** Null/undefined means unlimited. */
  maxPerDay?: number | null;
}

export interface ComputeSlotsInput {
  service: SlotServiceRules;
  availability: AvailabilityWindow[];
  blackouts: TimeRange[];
  /** Existing non-cancelled bookings. Their `endsAt` already includes buffer. */
  busy: TimeRange[];
  /** IANA zone, e.g. 'Asia/Manila'. */
  timezone: string;
  from: Date;
  to: Date;
  now: Date;
  vacationUntil?: Date | null;
}

export interface Slot {
  /** ISO-8601 UTC. The instant the session starts. */
  startsAt: string;
  /**
   * ISO-8601 UTC. The instant the *session* ends — not the instant the slot
   * stops blocking the calendar, which is `endsAt + bufferMinutes`. This is
   * what a client is shown; `blockEndsAt` is what gets written to
   * `bookings.ends_at`.
   */
  endsAt: string;
  /** Session end plus the service's buffer. See `bookings.ends_at`. */
  blockEndsAt: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * How far the wall clock in `timezone` is ahead of UTC at a given instant, in
 * milliseconds.
 *
 * Formatting the instant in the target zone and re-reading those wall-clock
 * fields as if they were UTC yields exactly the offset — the standard trick for
 * doing zone math with only `Intl`.
 */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // 'en-US' with hour12:false renders midnight as 24 rather than 0.
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * Converts a wall-clock moment in `timezone` to the UTC instant it names.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so this guesses using the offset at the naive value and then refines
 * once with the offset at the guessed instant. One refinement is sufficient for
 * every real zone: offsets shift by at most a couple of hours, far less than
 * the gap that would be needed for the second guess to land in a different
 * offset period again.
 */
function wallClockToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  minutes: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * MINUTE_MS;
  let instant = naive - zoneOffsetMs(new Date(naive), timezone);
  instant = naive - zoneOffsetMs(new Date(instant), timezone);
  return new Date(instant);
}

/** The calendar date showing on a clock in `timezone` at `instant`. */
function localDateParts(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: field('year'), month: field('month'), day: field('day') };
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // Half-open on both sides, matching the `[)` bounds on the database's
  // exclusion constraint — so back-to-back sessions do not read as a clash.
  return aStart < bEnd && bStart < aEnd;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * All bookable slots for one service between `from` and `to`.
 *
 * Returned in ascending time order. An empty array is a normal answer — a fully
 * booked week, a facilitator on vacation, or a service whose notice period
 * swallows the whole requested range all legitimately produce no slots.
 */
export function computeSlots(input: ComputeSlotsInput): Slot[] {
  const { service, availability, blackouts, busy, timezone, from, to, now } = input;

  if (availability.length === 0) return [];
  if (service.durationMinutes <= 0) return [];

  const nowMs = now.getTime();
  const vacationUntilMs = input.vacationUntil ? toMs(input.vacationUntil) : 0;

  // The window a slot must fall inside, as instants. min-notice sets the floor,
  // max-advance the ceiling, and the caller's from/to narrow it further.
  const earliestMs = Math.max(from.getTime(), nowMs + service.minNoticeMinutes * MINUTE_MS, vacationUntilMs);
  const latestMs = Math.min(to.getTime(), nowMs + service.maxAdvanceDays * DAY_MS);
  if (earliestMs >= latestMs) return [];

  // Index the weekly rules by weekday so the day loop is a lookup, not a scan.
  const byWeekday = new Map<number, AvailabilityWindow[]>();
  for (const window of availability) {
    if (window.endMinute <= window.startMinute) continue;
    const list = byWeekday.get(window.weekday) ?? [];
    list.push(window);
    byWeekday.set(window.weekday, list);
  }

  const blackoutRanges = blackouts.map((b) => [toMs(b.startsAt), toMs(b.endsAt)] as const);
  const busyRanges = busy.map((b) => [toMs(b.startsAt), toMs(b.endsAt)] as const);

  const slotMs = service.durationMinutes * MINUTE_MS;
  const blockMs = (service.durationMinutes + service.bufferMinutes) * MINUTE_MS;

  const slots: Slot[] = [];

  // Walk local calendar dates, not fixed 24h steps: a DST day is 23 or 25 hours
  // long, and stepping by DAY_MS through one would skip or repeat a date.
  // Starting a day early and ending a day late covers the case where the
  // requested UTC range clips a local day at either end.
  let cursor = localDateParts(new Date(earliestMs - DAY_MS), timezone);
  const lastDate = localDateParts(new Date(latestMs + DAY_MS), timezone);
  const lastOrdinal = Date.UTC(lastDate.year, lastDate.month - 1, lastDate.day);

  for (let guard = 0; guard < 400; guard += 1) {
    const ordinal = Date.UTC(cursor.year, cursor.month - 1, cursor.day);
    if (ordinal > lastOrdinal) break;

    // Safe because `ordinal` is a bare calendar date pinned to UTC midnight —
    // it carries no zone of its own, so getUTCDay is the calendar weekday.
    const weekday = new Date(ordinal).getUTCDay();
    const windows = byWeekday.get(weekday) ?? [];

    if (windows.length > 0) {
      // maxPerDay is a cap on how many sessions may be *booked* in the
      // facilitator's local day — not on how many are offered. Once the cap is
      // reached the day closes entirely; below it, every free slot stays
      // visible. Capping the offer instead would hide legitimate afternoon
      // slots, and would make this function disagree with `isBookableSlot`,
      // which sees a one-minute window and cannot know how many earlier slots
      // a full-day call would have generated. That disagreement is exactly the
      // shape of bug that lets someone book a time the UI never showed.
      const dayStartMs = wallClockToUtc(timezone, cursor.year, cursor.month, cursor.day, 0).getTime();
      const dayEndMs = wallClockToUtc(timezone, cursor.year, cursor.month, cursor.day + 1, 0).getTime();

      const bookedToday = busyRanges.filter(([s]) => s >= dayStartMs && s < dayEndMs).length;
      const dayIsFull = service.maxPerDay != null && bookedToday >= service.maxPerDay;

      if (!dayIsFull) for (const window of windows) {
        // Step by the full block so generated slots never overlap each other
        // and the buffer is real spacing rather than a gap the next slot
        // immediately fills.
        for (let minute = window.startMinute; minute + service.durationMinutes <= window.endMinute; minute += service.durationMinutes + service.bufferMinutes) {
          const startMs = wallClockToUtc(timezone, cursor.year, cursor.month, cursor.day, minute).getTime();
          const endMs = startMs + slotMs;
          const blockEndMs = startMs + blockMs;

          if (startMs < earliestMs || startMs >= latestMs) continue;

          // Blackouts and existing bookings are both tested against the padded
          // range: a session whose buffer runs into the next appointment is
          // not bookable, and the database constraint would reject it anyway.
          if (blackoutRanges.some(([s, e]) => overlaps(startMs, blockEndMs, s, e))) continue;
          if (busyRanges.some(([s, e]) => overlaps(startMs, blockEndMs, s, e))) continue;

          slots.push({
            startsAt: new Date(startMs).toISOString(),
            endsAt: new Date(endMs).toISOString(),
            blockEndsAt: new Date(blockEndMs).toISOString(),
          });
        }
      }
    }

    // Overflowing `day` past the month length is intentional — Date.UTC
    // normalises Jan 32 to Feb 1, which is exactly the rollover wanted.
    cursor = localDateParts(new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1)), timezone);
  }

  slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return slots;
}

/**
 * Whether `startsAt` is one of the slots this service actually offers.
 *
 * The authorization check behind `POST /bookings`. Narrow window on purpose:
 * regenerating a whole month to validate one instant is wasteful, and a range
 * that starts exactly at the candidate keeps the comparison exact.
 */
export function isBookableSlot(
  startsAt: Date,
  input: Omit<ComputeSlotsInput, 'from' | 'to'>,
): Slot | null {
  const slots = computeSlots({
    ...input,
    from: new Date(startsAt.getTime() - MINUTE_MS),
    to: new Date(startsAt.getTime() + MINUTE_MS),
  });
  const target = startsAt.toISOString();
  return slots.find((s) => s.startsAt === target) ?? null;
}
