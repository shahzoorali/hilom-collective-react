/**
 * Loads everything the slot engine needs and runs it.
 *
 * The point of this module is that the public availability endpoint and the
 * create-booking handler go through the *same* function. If the picker and the
 * server-side re-check ever loaded different inputs — a stale blackout, a
 * different busy window — clients would be shown slots that then refuse to
 * book, which reads as a broken site rather than as a race.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeSlots,
  isBookableSlot,
  type ComputeSlotsInput,
  type Slot,
  type SlotServiceRules,
} from './slots.js';
import { HOLD_MINUTES } from './booking-domain.js';

/**
 * What a visitor may see of a facilitator.
 *
 * `website_url` and `years_experience` are the only two intake columns from
 * 0023 that belong here — a link the facilitator published themselves, and a
 * coarse experience bucket that is a credibility signal rather than personal
 * data. Everything else the application form collects (contact preference,
 * phone, referral source, which Hilom service track they asked for, their
 * certification document, the consent record) is internal and must stay off
 * this list.
 */
export const FACILITATOR_PUBLIC_COLUMNS =
  'id, slug, display_name, headline, bio, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, website_url, years_experience, timezone, status';

export const SERVICE_PUBLIC_COLUMNS =
  'id, facilitator_id, kind, title, description, duration_minutes, price_centavos, currency, sessions_count, delivery_mode, meeting_provider, buffer_minutes, min_notice_minutes, max_advance_days, max_per_day, cancellation_policy, refund_full_hours, refund_half_hours, intake_questions, is_active, sort_order';

export interface ServiceRow {
  id: string;
  facilitator_id: string;
  kind: 'exploratory' | 'standard' | 'package';
  title: string;
  duration_minutes: number;
  price_centavos: number;
  currency: string;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  max_per_day: number | null;
  /** >1 only for `package` — the number of credits a purchase grants (0035). */
  sessions_count?: number;
  meeting_url?: string | null;
  /** Null only on a row read with a column list predating 0027. */
  refund_full_hours?: number | null;
  refund_half_hours?: number | null;
  /** Pre-session intake form definition (0032). */
  intake_questions?: unknown;
  is_active: boolean;
}

export interface FacilitatorSchedulingRow {
  id: string;
  timezone: string;
  vacation_until: string | null;
  status: string;
}

/** Maps a service row onto the engine's rule shape. */
export function serviceRules(service: ServiceRow): SlotServiceRules {
  return {
    durationMinutes: service.duration_minutes,
    bufferMinutes: service.buffer_minutes,
    minNoticeMinutes: service.min_notice_minutes,
    maxAdvanceDays: service.max_advance_days,
    maxPerDay: service.max_per_day,
  };
}

interface SchedulingContext {
  availability: { weekday: number; startMinute: number; endMinute: number }[];
  blackouts: { startsAt: string; endsAt: string }[];
  busy: { startsAt: string; endsAt: string }[];
}

/**
 * Reads the facilitator's rules and current commitments.
 *
 * Expired holds are filtered out here rather than in SQL so that the same
 * `now` drives both this and the slot maths — a hold that expires between the
 * query and the computation must not be treated as busy by one and free by the
 * other. The sweep job deletes them for real; this just declines to honour a
 * hold that has already lapsed, which is what lets an abandoned checkout free
 * its slot immediately rather than at the next sweep.
 */
async function loadContext(
  supabase: SupabaseClient,
  facilitatorId: string,
  from: Date,
  to: Date,
  now: Date,
  excludeBookingId?: string,
): Promise<SchedulingContext> {
  const [availabilityRes, blackoutRes, busyRes] = await Promise.all([
    supabase
      .from('facilitator_availability')
      .select('weekday, start_minute, end_minute')
      .eq('facilitator_id', facilitatorId),
    supabase
      .from('facilitator_blackouts')
      .select('starts_at, ends_at')
      .eq('facilitator_id', facilitatorId)
      // Only blackouts that could touch the requested range.
      .lt('starts_at', to.toISOString())
      .gt('ends_at', from.toISOString()),
    supabase
      .from('bookings')
      .select('id, starts_at, ends_at, status, hold_expires_at')
      .eq('facilitator_id', facilitatorId)
      .in('status', ['pending_payment', 'confirmed'])
      .lt('starts_at', to.toISOString())
      .gt('ends_at', from.toISOString()),
  ]);

  if (availabilityRes.error) throw availabilityRes.error;
  if (blackoutRes.error) throw blackoutRes.error;
  if (busyRes.error) throw busyRes.error;

  const busy = (busyRes.data ?? [])
    .filter((row) => {
      // A booking being rescheduled must not block itself. Without this,
      // nudging a 10:00 session to 10:30 is refused as "unavailable" — its own
      // old slot overlaps the new one. The database has no such problem: the
      // exclusion constraint compares a row against *other* rows.
      if (excludeBookingId && row.id === excludeBookingId) return false;
      if (row.status !== 'pending_payment') return true;
      return !row.hold_expires_at || new Date(row.hold_expires_at).getTime() > now.getTime();
    })
    .map((row) => ({ startsAt: row.starts_at as string, endsAt: row.ends_at as string }));

  return {
    availability: (availabilityRes.data ?? []).map((row) => ({
      weekday: row.weekday as number,
      startMinute: row.start_minute as number,
      endMinute: row.end_minute as number,
    })),
    blackouts: (blackoutRes.data ?? []).map((row) => ({
      startsAt: row.starts_at as string,
      endsAt: row.ends_at as string,
    })),
    busy,
  };
}

/** Bookable slots for one service across a date range. */
export async function availableSlots(
  supabase: SupabaseClient,
  facilitator: FacilitatorSchedulingRow,
  service: ServiceRow,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<Slot[]> {
  // Widen the context read by a day either side so a session starting just
  // before `from`, or a blackout straddling `to`, still registers as busy.
  const pad = 86_400_000;
  const context = await loadContext(supabase, facilitator.id, new Date(from.getTime() - pad), new Date(to.getTime() + pad), now);

  return computeSlots({
    service: serviceRules(service),
    ...context,
    timezone: facilitator.timezone,
    vacationUntil: facilitator.vacation_until ? new Date(facilitator.vacation_until) : null,
    from,
    to,
    now,
  });
}

/**
 * Verifies one requested instant, returning the slot or null.
 *
 * This is the authorization check behind `POST /bookings`, and the reason the
 * request body carries only a start time: everything else about the booking —
 * duration, price, the padded end written to the row — is derived here from the
 * database, never from the caller.
 *
 * Note it is still not the *last* line of defence. Between this returning a
 * slot and the insert committing, another request can take it; the exclusion
 * constraint in 0012_bookings.sql is what actually settles that. This check
 * exists to reject the illegitimate (off-grid times, blackouts, ignored notice
 * periods), not to win the race.
 */
export async function verifySlot(
  supabase: SupabaseClient,
  facilitator: FacilitatorSchedulingRow,
  service: ServiceRow,
  startsAt: Date,
  now: Date = new Date(),
  /** Set when rescheduling, so the booking does not collide with itself. */
  excludeBookingId?: string,
): Promise<Slot | null> {
  const pad = 86_400_000;
  const context = await loadContext(
    supabase,
    facilitator.id,
    new Date(startsAt.getTime() - pad),
    new Date(startsAt.getTime() + pad),
    now,
    excludeBookingId,
  );

  return isBookableSlot(startsAt, {
    service: serviceRules(service),
    ...context,
    timezone: facilitator.timezone,
    vacationUntil: facilitator.vacation_until ? new Date(facilitator.vacation_until) : null,
    now,
  });
}

/**
 * Deletes lapsed `pending_payment` rows for one facilitator.
 *
 * Called immediately before a booking insert as well as from the sweep job.
 * The exclusion constraint cannot read `hold_expires_at` — it sees a
 * `pending_payment` row and blocks — so an abandoned checkout would otherwise
 * keep its slot until the next scheduled sweep. Clearing them inline makes the
 * slot bookable the moment the hold lapses, which is what the availability
 * endpoint has already been telling clients.
 */
export async function releaseExpiredHolds(
  supabase: SupabaseClient,
  facilitatorId: string,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('facilitator_id', facilitatorId)
    .eq('status', 'pending_payment')
    .lt('hold_expires_at', now.toISOString());
  if (error) throw error;
}

/** The instant a hold taken now should lapse. */
export function holdExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Preview and diagnosis — what a client would actually see
// ---------------------------------------------------------------------------

/**
 * One reason the facilitator's own rules produced nothing.
 *
 * `rule` names the setting to go and change; `message` is what the dashboard
 * shows. Both are needed: the message has to be readable, and the screen wants
 * to be able to link straight at the field.
 */
export interface AvailabilityFinding {
  rule:
    | 'no_weekly_hours'
    | 'windows_too_short'
    | 'vacation'
    | 'min_notice'
    | 'max_advance'
    | 'blackouts'
    | 'fully_booked'
    | 'max_per_day';
  message: string;
}

export interface AvailabilityPreview {
  slots: Slot[];
  /**
   * Empty when there are slots. When there are none, the settings that —
   * relaxed one at a time — would have produced some.
   */
  findings: AvailabilityFinding[];
}

/**
 * The slots a client would see, plus why there are none.
 *
 * A facilitator configures four interacting rules (buffer, minimum notice,
 * advance window, daily cap) on top of a weekly grid, a vacation date and a
 * blackout list, and until now had no way to see the result. Misconfiguration
 * was silent: 12 hours' notice plus a 2-hour buffer plus `max_per_day: 1`
 * produces an empty calendar, and the only symptom is that bookings stop.
 *
 * The diagnosis works by *relaxation*, not by reasoning about the rules: run
 * the real engine, and if it returns nothing, run it again with one constraint
 * removed. If removing that constraint produces slots, it is the one standing
 * in the way. This cannot drift out of step with the engine the way a
 * hand-written explanation would — it is the same `computeSlots` deciding both
 * the answer and the reason for it.
 *
 * More than one finding is normal and correct: two rules can each be
 * sufficient on their own to empty the calendar, and fixing only the one we
 * happened to name first would leave the facilitator exactly where they were.
 */
export async function previewAvailability(
  supabase: SupabaseClient,
  facilitator: FacilitatorSchedulingRow,
  service: ServiceRow,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<AvailabilityPreview> {
  const pad = 86_400_000;
  const context = await loadContext(
    supabase,
    facilitator.id,
    new Date(from.getTime() - pad),
    new Date(to.getTime() + pad),
    now,
  );

  return diagnoseAvailability({
    service: serviceRules(service),
    ...context,
    timezone: facilitator.timezone,
    vacationUntil: facilitator.vacation_until ? new Date(facilitator.vacation_until) : null,
    from,
    to,
    now,
  });
}

/**
 * The pure half of `previewAvailability`: everything except the database read.
 *
 * Split out so the diagnosis can be tested against hand-built rule sets — the
 * whole point of it is to be right about *why* a particular combination of
 * settings is empty, and that is not something a mocked Supabase client would
 * tell us anything about.
 *
 * The method is *isolation*, not relaxation. The obvious approach — lift one
 * rule at a time and see whether slots appear — is wrong whenever two rules are
 * each enough to empty the week on their own: with both a vacation and a
 * covering blackout in place, lifting either one still leaves nothing, so
 * neither gets named and the facilitator is told nothing at all. So instead
 * each rule is tested *alone*, against an otherwise fully permissive
 * configuration. A rule that empties the week by itself is a rule worth
 * naming, whatever else is also wrong — and fixing only one of them will not
 * be enough, which is exactly what the list is there to say.
 */
export function diagnoseAvailability(input: ComputeSlotsInput): AvailabilityPreview {
  const slots = computeSlots(input);
  if (slots.length > 0) return { slots, findings: [] };

  const findings: AvailabilityFinding[] = [];
  const rules = input.service;
  const { availability } = input;

  if (availability.length === 0) {
    findings.push({
      rule: 'no_weekly_hours',
      message: "You haven't set any weekly hours, so there is nothing to offer.",
    });
    // Nothing further can be said: every test below projects the same empty
    // grid and would report no cause at all.
    return { slots, findings };
  }

  // Everything optional switched off. If this is still empty then no
  // *configurable* rule is to blame — the weekly grid itself cannot hold the
  // session, or the requested range contains none of it.
  const permissive: ComputeSlotsInput = {
    ...input,
    service: { ...rules, minNoticeMinutes: 0, maxAdvanceDays: 365, maxPerDay: null },
    blackouts: [],
    busy: [],
    vacationUntil: null,
  };

  if (computeSlots(permissive).length === 0) {
    const longestWindow = Math.max(...availability.map((w) => w.endMinute - w.startMinute));
    if (rules.durationMinutes > longestWindow) {
      findings.push({
        rule: 'windows_too_short',
        message:
          `A ${rules.durationMinutes}-minute session does not fit in your longest weekly window, ` +
          `which is ${longestWindow} minutes.`,
      });
    } else {
      // The grid is fine but none of it falls in this period — a Monday-only
      // facilitator previewing a range with no Monday in it.
      findings.push({
        rule: 'no_weekly_hours',
        message: 'None of your weekly hours fall in this period.',
      });
    }
    return { slots, findings };
  }

  /** Does this one rule, applied on its own, empty the period? */
  const empties = (override: Partial<ComputeSlotsInput>) =>
    computeSlots({ ...permissive, ...override }).length === 0;

  if (input.vacationUntil && empties({ vacationUntil: input.vacationUntil })) {
    findings.push({
      rule: 'vacation',
      message: 'Your away-until date covers this whole period — new bookings are paused.',
    });
  }

  if (
    rules.minNoticeMinutes > 0 &&
    empties({ service: { ...permissive.service, minNoticeMinutes: rules.minNoticeMinutes } })
  ) {
    const hours = Math.round((rules.minNoticeMinutes / 60) * 10) / 10;
    findings.push({
      rule: 'min_notice',
      message: `Your minimum notice of ${hours} hours pushes the first bookable time past this period.`,
    });
  }

  if (empties({ service: { ...permissive.service, maxAdvanceDays: rules.maxAdvanceDays } })) {
    findings.push({
      rule: 'max_advance',
      message: `Your booking window of ${rules.maxAdvanceDays} days ends before this period does.`,
    });
  }

  if (input.blackouts.length > 0 && empties({ blackouts: input.blackouts })) {
    findings.push({ rule: 'blackouts', message: 'Blackouts cover every open hour in this period.' });
  }

  if (input.busy.length > 0 && empties({ busy: input.busy })) {
    findings.push({ rule: 'fully_booked', message: 'Every open hour in this period is already booked.' });
  }

  if (
    rules.maxPerDay != null &&
    // The cap only bites in combination with what is already booked, so this
    // one is tested with the real diary rather than an empty one — otherwise a
    // limit of 1 with nothing booked would look like the culprit.
    empties({ service: { ...permissive.service, maxPerDay: rules.maxPerDay }, busy: input.busy })
  ) {
    findings.push({
      rule: 'max_per_day',
      message: `Your limit of ${rules.maxPerDay} session${rules.maxPerDay === 1 ? '' : 's'} a day is already met on every open day.`,
    });
  }

  // Every rule passed in isolation, yet together they leave nothing. Say so
  // rather than showing an empty explanation for an empty calendar.
  if (findings.length === 0) {
    findings.push({
      rule: 'no_weekly_hours',
      message:
        'No single setting is responsible — your notice period, booking window, buffer, daily ' +
        'limit, time off and existing sessions together leave no bookable time in this period.',
    });
  }

  return { slots, findings };
}
