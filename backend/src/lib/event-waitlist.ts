/**
 * A "tell me when a seat opens up" list for a sold-out event date (0054,
 * Phase 2).
 *
 * Not a held reservation — see the header comment in migration 0060 for why.
 * This file is deliberately small: join, notify, convert. A priority hold
 * with its own seat number is a real change to `claim_event_seat` and its
 * exclusion index, and does not belong in this file if it is ever built.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendWaitlistJoined, sendWaitlistSpotOpen } from './registration-email.js';

/** Statuses that occupy a seat right now — the same set `claim_event_seat` and the admin list count against capacity (0016). */
const SEAT_STATUSES = ['pending_payment', 'confirmed'];

export class WaitlistError extends Error {}

interface EventForWaitlist {
  id: string;
  title: string;
  status: string;
  ticketing_enabled: boolean;
  capacity: number | null;
  starts_at: string;
}

async function seatsTaken(supabase: SupabaseClient, eventId: string): Promise<number> {
  const { count, error } = await supabase
    .from('event_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .in('status', SEAT_STATUSES);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Joins the waitlist for a sold-out date.
 *
 * Refuses when the event is not actually sold out — someone should register
 * normally, and offering a waitlist join for a place they could just take is
 * the kind of dead end that generates a support message. The unique index on
 * `(event_id, lower(email)) where status = 'waiting'` is the second line of
 * defence against a double join; this check is the first, readable one.
 */
export async function joinWaitlist(
  supabase: SupabaseClient,
  input: { eventId: string; email: string; name: string; phone?: string | null },
): Promise<{ id: string }> {
  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title, status, ticketing_enabled, capacity, starts_at')
    .eq('id', input.eventId)
    .maybeSingle<EventForWaitlist>();
  if (eventError) throw eventError;
  if (!eventRow || !eventRow.ticketing_enabled || eventRow.status !== 'published') {
    throw new WaitlistError('This event is not open for registration.');
  }
  if (eventRow.capacity === null) {
    throw new WaitlistError('This event is not ready to take registrations yet.');
  }

  const taken = await seatsTaken(supabase, input.eventId);
  if (taken < eventRow.capacity) {
    throw new WaitlistError('There are still places open — register instead of joining the waitlist.');
  }

  const { data, error } = await supabase
    .from('event_waitlist')
    .insert({
      event_id: input.eventId,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim().slice(0, 200),
      phone: input.phone?.trim().slice(0, 40) || null,
    })
    .select('id')
    .single<{ id: string }>();
  if (error) {
    if (error.code === '23505') throw new WaitlistError("You're already on the waitlist for this event.");
    throw error;
  }

  await sendWaitlistJoined({ to: input.email, name: input.name, eventTitle: eventRow.title }).catch(
    (err: unknown) => {
      console.error('[event-waitlist] join confirmation failed', { eventId: input.eventId, err });
    },
  );

  return data;
}

/**
 * Flips a live waitlist entry to `converted` once its owner has registered.
 *
 * Called from `register()` after a successful claim. Best-effort and
 * deliberately never throws into the caller — a seat was just paid for and
 * held, and a failure to tidy up the waitlist row must not roll that back.
 * Matches on email, not on a waitlist id the registration form never carries.
 */
export async function convertWaitlistEntry(supabase: SupabaseClient, eventId: string, email: string): Promise<void> {
  try {
    await supabase
      .from('event_waitlist')
      .update({ status: 'converted' })
      .eq('event_id', eventId)
      .eq('email', email.trim().toLowerCase())
      .in('status', ['waiting', 'notified']);
  } catch (err) {
    console.error('[event-waitlist] could not mark entry converted', { eventId, email, err });
  }
}

interface WaitlistRow {
  id: string;
  email: string;
  name: string;
}

/**
 * Tells the oldest waiting people a seat is open, up to however many
 * actually are.
 *
 * Run from the registration sweep, one event at a time, so a lock held by a
 * concurrent registration on that event's capacity is never in question —
 * this reads the count fresh, notifies what it saw, and the next sweep pass
 * corrects for anything that changed in between rather than trying to hold a
 * lock across an email send.
 */
export async function notifyOpenSeats(supabase: SupabaseClient, eventId: string): Promise<number> {
  const { data: eventRow, error: eventError } = await supabase
    .from('events')
    .select('id, title, status, ticketing_enabled, capacity, starts_at')
    .eq('id', eventId)
    .maybeSingle<EventForWaitlist>();
  if (eventError) throw eventError;
  if (!eventRow || !eventRow.ticketing_enabled || eventRow.status !== 'published' || eventRow.capacity === null) {
    return 0;
  }

  const taken = await seatsTaken(supabase, eventId);
  const available = eventRow.capacity - taken;
  if (available <= 0) return 0;

  const { data: waiting, error: waitingError } = await supabase
    .from('event_waitlist')
    .select('id, email, name')
    .eq('event_id', eventId)
    .eq('status', 'waiting')
    .order('joined_at', { ascending: true })
    .limit(available)
    .returns<WaitlistRow[]>();
  if (waitingError) throw waitingError;
  if (!waiting || waiting.length === 0) return 0;

  let notified = 0;
  for (const entry of waiting) {
    // The claim: only an entry still `waiting` is moved, so two overlapping
    // sweeps for the same event cannot both notify the same person for two
    // different seats.
    const { data: claimed, error: claimError } = await supabase
      .from('event_waitlist')
      .update({ status: 'notified', notified_at: new Date().toISOString() })
      .eq('id', entry.id)
      .eq('status', 'waiting')
      .select('id')
      .maybeSingle<{ id: string }>();
    if (claimError) {
      console.error('[event-waitlist] could not claim notification', { entryId: entry.id, claimError });
      continue;
    }
    if (!claimed) continue;

    try {
      await sendWaitlistSpotOpen({
        to: entry.email,
        name: entry.name,
        eventTitle: eventRow.title,
        eventId: eventRow.id,
      });
      notified += 1;
    } catch (err) {
      console.error('[event-waitlist] notification send failed, releasing for retry', { entryId: entry.id, err });
      await supabase.from('event_waitlist').update({ status: 'waiting', notified_at: null }).eq('id', entry.id);
    }
  }

  return notified;
}
