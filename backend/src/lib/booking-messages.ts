/**
 * The per-booking message thread (0034).
 *
 * Shared by both sides — `bookings.ts` for the client and
 * `facilitator-portal.ts` for the facilitator — because everything except *who
 * is asking* is identical, and two copies of "post a message and notify the
 * other party" would eventually notify different people.
 *
 * Each handler is responsible for proving the caller owns the booking before
 * calling in here. This module takes the side as a given.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendNewMessage } from './booking-email.js';
import { stripTags } from './sanitize.js';

export type MessageSide = 'client' | 'facilitator';

export interface BookingMessage {
  id: string;
  sender: MessageSide;
  body: string;
  created_at: string;
  read_at: string | null;
}

export class MessageError extends Error {}

const MAX_BODY = 5000;

/**
 * How long a run of messages from the same person collapses into one
 * notification.
 *
 * Without this, a live back-and-forth — three quick messages while someone is
 * mid-thought — is three emails, and the emails stop being read. Fifteen
 * minutes is long enough to cover typing a thought out in pieces and short
 * enough that a genuinely new message hours later still arrives as one.
 */
const NOTIFICATION_QUIET_MINUTES = 15;

/** The thread, oldest first, which is how a conversation reads. */
export async function listMessages(
  supabase: SupabaseClient,
  bookingId: string,
): Promise<BookingMessage[]> {
  const { data, error } = await supabase
    .from('booking_messages')
    .select('id, sender, body, created_at, read_at')
    .eq('booking_id', bookingId)
    .order('created_at')
    .limit(500);

  if (error) throw error;
  return (data ?? []) as BookingMessage[];
}

/**
 * Marks everything the *other* side wrote as read.
 *
 * Called when a thread is opened. Deliberately does not touch the caller's own
 * messages: `read_at` on a message means "the recipient has seen this", and a
 * sender re-reading their own would otherwise mark it read on the other
 * person's behalf.
 */
export async function markThreadRead(
  supabase: SupabaseClient,
  bookingId: string,
  reader: MessageSide,
): Promise<void> {
  const { error } = await supabase
    .from('booking_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('booking_id', bookingId)
    .neq('sender', reader)
    .is('read_at', null);
  if (error) throw error;
}

/** How many messages from the other side this reader has not yet seen. */
export async function unreadCount(
  supabase: SupabaseClient,
  bookingId: string,
  reader: MessageSide,
): Promise<number> {
  const { count, error } = await supabase
    .from('booking_messages')
    .select('id', { count: 'exact', head: true })
    .eq('booking_id', bookingId)
    .neq('sender', reader)
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Whether to email the other party about this message.
 *
 * True unless the same sender already wrote in this thread within the quiet
 * window — see NOTIFICATION_QUIET_MINUTES. Checked *before* the new row is
 * inserted, so "the last message" means the previous one.
 */
async function shouldNotify(
  supabase: SupabaseClient,
  bookingId: string,
  sender: MessageSide,
  now: Date,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('booking_messages')
    .select('sender, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ sender: MessageSide; created_at: string }>();

  if (error) throw error;
  if (!data || data.sender !== sender) return true;

  const minutesSince = (now.getTime() - new Date(data.created_at).getTime()) / 60_000;
  return minutesSince >= NOTIFICATION_QUIET_MINUTES;
}

/**
 * Posts a message and, usually, emails the other party.
 *
 * The email is best-effort and never blocks the post, for the same reason
 * every other notification here is: the message is stored, both parties can see
 * it in the thread, and a failed send is recoverable in a way that a lost
 * message is not.
 */
export async function postMessage(
  supabase: SupabaseClient,
  input: {
    bookingId: string;
    sender: MessageSide;
    senderEmail: string;
    body: unknown;
    /** Everything the notification needs. Loaded by the caller, which already has it. */
    notify: {
      clientEmail: string;
      clientName: string | null;
      clientTimezone: string | null;
      facilitatorEmail: string;
      facilitatorName: string;
      facilitatorTimezone: string;
      serviceTitle: string;
      startsAt: string;
    };
  },
): Promise<BookingMessage> {
  // Tags stripped rather than escaped: this is rendered as plain text on both
  // ends and in the email, and storing markup that every reader must then
  // remember to neutralise is how a stored-XSS gets one reader wrong.
  const body = stripTags(typeof input.body === 'string' ? input.body : '').trim();
  if (!body) throw new MessageError('Write something first');
  if (body.length > MAX_BODY) throw new MessageError('That message is too long');

  const now = new Date();
  const notify = await shouldNotify(supabase, input.bookingId, input.sender, now);

  const { data, error } = await supabase
    .from('booking_messages')
    .insert({
      booking_id: input.bookingId,
      sender: input.sender,
      sender_email: input.senderEmail,
      body,
    })
    .select('id, sender, body, created_at, read_at')
    .maybeSingle<BookingMessage>();

  if (error) throw error;
  if (!data) throw new Error('Message insert returned no row');

  if (notify) {
    const toClient = input.sender === 'facilitator';
    await sendNewMessage(
      {
        clientEmail: input.notify.clientEmail,
        clientName: input.notify.clientName,
        clientTimezone: input.notify.clientTimezone,
        facilitatorEmail: input.notify.facilitatorEmail,
        facilitatorName: input.notify.facilitatorName,
        facilitatorTimezone: input.notify.facilitatorTimezone,
        serviceTitle: input.notify.serviceTitle,
        startsAt: input.notify.startsAt,
        isFree: false,
      },
      {
        toClient,
        fromName: toClient
          ? input.notify.facilitatorName
          : input.notify.clientName || input.notify.clientEmail,
        body,
      },
    ).catch((err: unknown) => {
      // The message is already stored and visible to both parties in the
      // thread; a failed send must not fail the post.
      console.warn('[booking-messages] notification failed, message is unaffected', {
        bookingId: input.bookingId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return data;
}
