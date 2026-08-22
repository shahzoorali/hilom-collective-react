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
import { computeSlots, isBookableSlot, type Slot, type SlotServiceRules } from './slots.js';
import { HOLD_MINUTES } from './booking-domain.js';

export const FACILITATOR_PUBLIC_COLUMNS =
  'id, slug, display_name, headline, bio, photo_url, credentials, specialties, languages, location, delivery_mode, scope_note, social_links, timezone, status';

export const SERVICE_PUBLIC_COLUMNS =
  'id, facilitator_id, kind, title, description, duration_minutes, price_centavos, currency, sessions_count, delivery_mode, buffer_minutes, min_notice_minutes, max_advance_days, max_per_day, cancellation_policy, is_active, sort_order';

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
  meeting_url?: string | null;
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
