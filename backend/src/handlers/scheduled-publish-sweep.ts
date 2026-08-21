/**
 * EventBridge-scheduled entry point (see the `ScheduledPublishRule` in the CDK
 * stack — runs every 5 minutes) that publishes any post or page whose
 * `scheduled_at` has arrived. All the actual work — including why this is a
 * plain database write with nothing else to trigger — is in
 * lib/scheduled-publish.ts; this file is just the Lambda wiring.
 */
import { publishDuePosts, publishDuePages } from '../lib/scheduled-publish.js';

export async function handler(): Promise<void> {
  const [posts, pages] = await Promise.all([
    publishDuePosts().catch((err) => {
      console.error('[scheduledPublishSweep] posts sweep failed', err);
      return 0;
    }),
    publishDuePages().catch((err) => {
      console.error('[scheduledPublishSweep] pages sweep failed', err);
      return 0;
    }),
  ]);

  if (posts > 0 || pages > 0) {
    console.log(`[scheduledPublishSweep] published ${posts} post(s), ${pages} page(s)`);
  }
}
