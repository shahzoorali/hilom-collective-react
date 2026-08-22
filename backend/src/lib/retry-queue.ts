/**
 * Thin wrapper around the SQS retry queue. The queue URL is injected via
 * environment variable by CDK rather than looked up at runtime — it's
 * infrastructure identity, not a secret, so it doesn't belong in Secrets
 * Manager.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

let client: SQSClient | undefined;

/**
 * What kind of work a retry message refers to.
 *
 * The queue carries both course enrollments and booking confirmations. They
 * share one queue rather than getting one each because they share everything
 * that matters about retrying — the same backoff, the same DLQ, the same alarm
 * — and a second queue would mean a second alarm nobody remembers to watch.
 */
export type RetryKind = 'order' | 'booking';

/**
 * `kind` defaults to 'order' so that messages enqueued by the previous version
 * of this code — which are potentially still in flight on the queue during a
 * deploy — keep meaning what they meant when they were written.
 */
export async function enqueueRetry(
  targetId: string,
  reason: string,
  kind: RetryKind = 'order',
): Promise<void> {
  const queueUrl = process.env.ENROLLMENT_RETRY_QUEUE_URL;
  if (!queueUrl) throw new Error('ENROLLMENT_RETRY_QUEUE_URL is not set');

  if (!client) client = new SQSClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });

  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        kind,
        // `orderId` is kept as the field name for both kinds so an in-flight
        // message written before this change still parses. The consumer reads
        // `kind` to know what the id points at.
        orderId: targetId,
        reason,
        enqueuedAt: new Date().toISOString(),
      }),
    }),
  );
}
