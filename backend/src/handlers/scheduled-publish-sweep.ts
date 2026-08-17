/**
 * EventBridge-scheduled entry point (see the `ScheduledPublishRule` in the CDK
 * stack — runs every 5 minutes) that publishes any post or page whose
 * `scheduled_at` has arrived. All the actual work is in
 * lib/scheduled-publish.ts; this file is just the Lambda wiring plus the
 * "did anything change" decision for whether to kick an Amplify rebuild.
 *
 * One rebuild per sweep tick, not one per row: if three scheduled posts land
 * in the same 5-minute window, that is one rebuild, not three queued back to
 * back for no benefit.
 */
import { publishDuePosts, publishDuePages } from '../lib/scheduled-publish.js';
import { triggerAmplifyBuild } from '../lib/amplify-build.js';

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
    await triggerAmplifyBuild('scheduledPublishSweep').catch((err) =>
      console.warn('[scheduledPublishSweep] build trigger failed', err),
    );
  }
}
