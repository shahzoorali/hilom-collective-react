/**
 * SES delivery outcomes → reminder delivery status.
 *
 * SES sends from ap-south-1; the `hilom-transactional` configuration set there
 * publishes Delivery/Bounce/Complaint/Reject/DeliveryDelay events to an SNS
 * topic, which this Lambda (in ap-southeast-1) is subscribed to across regions.
 *
 * Only payment reminders store a message id today, so an event for any other
 * Hilom email matches no row and is just logged. Every event is logged either
 * way, so CloudWatch has the full delivery trail for all registration email.
 */
import type { SNSEvent } from 'aws-lambda';
import { getSupabase } from '../lib/supabase.js';

type Status = 'delivered' | 'bounced' | 'complained' | 'rejected' | 'delayed';

const STATUS: Record<string, Status> = {
  Delivery: 'delivered',
  Bounce: 'bounced',
  Complaint: 'complained',
  Reject: 'rejected',
  DeliveryDelay: 'delayed',
};

interface SesEvent {
  eventType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: { bounceType?: string; bounceSubType?: string; bouncedRecipients?: { diagnosticCode?: string }[] };
  complaint?: { complaintFeedbackType?: string };
  reject?: { reason?: string };
  delivery?: { smtpResponse?: string };
  deliveryDelay?: { delayType?: string };
}

function detailOf(e: SesEvent): string | null {
  switch (e.eventType) {
    case 'Bounce': {
      const code = e.bounce?.bouncedRecipients?.[0]?.diagnosticCode;
      return [e.bounce?.bounceType, e.bounce?.bounceSubType, code].filter(Boolean).join(' — ') || null;
    }
    case 'Complaint':
      return e.complaint?.complaintFeedbackType ?? 'Marked as spam';
    case 'Reject':
      return e.reject?.reason ?? null;
    case 'DeliveryDelay':
      return e.deliveryDelay?.delayType ?? null;
    case 'Delivery':
      return e.delivery?.smtpResponse ?? null;
    default:
      return null;
  }
}

export async function handler(event: SNSEvent): Promise<void> {
  const supabase = await getSupabase();

  for (const record of event.Records) {
    let e: SesEvent;
    try {
      e = JSON.parse(record.Sns.Message) as SesEvent;
    } catch {
      console.warn('[sesEvents] unparseable message', { messageId: record.Sns.MessageId });
      continue;
    }
    const messageId = e.mail?.messageId;
    const status = e.eventType ? STATUS[e.eventType] : undefined;
    console.log('[sesEvents]', { eventType: e.eventType, messageId, to: e.mail?.destination });
    if (!messageId || !status) continue;

    let update = supabase
      .from('registration_charge_reminders')
      .update({ delivery_status: status, delivery_detail: detailOf(e), delivery_updated_at: new Date().toISOString() })
      .eq('ses_message_id', messageId);
    // A late "delayed" must not overwrite a final outcome that already arrived.
    if (status === 'delayed') update = update.in('delivery_status', ['sent', 'delayed']);
    const { error } = await update;
    if (error) throw error;
  }
}
