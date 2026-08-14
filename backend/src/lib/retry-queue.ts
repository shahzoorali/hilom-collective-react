/**
 * Thin wrapper around the SQS retry queue. The queue URL is injected via
 * environment variable by CDK rather than looked up at runtime — it's
 * infrastructure identity, not a secret, so it doesn't belong in Secrets
 * Manager.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

let client: SQSClient | undefined;

export async function enqueueRetry(orderId: string, reason: string): Promise<void> {
  const queueUrl = process.env.ENROLLMENT_RETRY_QUEUE_URL;
  if (!queueUrl) throw new Error('ENROLLMENT_RETRY_QUEUE_URL is not set');

  if (!client) client = new SQSClient({ region: process.env.AWS_REGION ?? 'ap-southeast-1' });

  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ orderId, reason, enqueuedAt: new Date().toISOString() }),
    }),
  );
}
