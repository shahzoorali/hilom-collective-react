/**
 * Scheduled-publish sweep — invoked on a periodic EventBridge schedule (not a
 * webhook, not called from the admin API) and publishes any post or page
 * whose `scheduled_at` has arrived.
 *
 * This is the same write admin-posts.ts / admin-pages.ts perform when an
 * editor clicks Publish immediately — copy draft_blocks -> published_blocks,
 * flip status, stamp published_at, write a revision, prune old ones — just
 * invoked by a clock instead of a click, and over a batch of due rows instead
 * of one. Kept as its own module rather than factored through the admin
 * handlers' single-row `publish()` because the two callers want different
 * things back: the admin route returns one HTTP response for one row, this
 * one silently processes a batch and only logs. Forcing both through one
 * function would mean one calling convention leaking into the other for a
 * modest amount of saved duplication.
 */
import { getSupabase } from './supabase.js';
import { validateBlocks } from './cms-blocks.js';

const REVISION_LIMIT = 20;

interface DueRow {
  id: string;
  draft_blocks: unknown;
}

async function pruneRevisions(
  table: 'page_revisions' | 'post_revisions',
  fkColumn: 'page_id' | 'post_id',
  id: string,
): Promise<void> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq(fkColumn, id)
    .order('created_at', { ascending: false })
    .range(REVISION_LIMIT, REVISION_LIMIT + 200);

  if (error || !data?.length) return;
  await supabase
    .from(table)
    .delete()
    .in(
      'id',
      data.map((r) => r.id),
    );
}

async function publishDueRows(
  table: 'pages' | 'posts',
  revisionTable: 'page_revisions' | 'post_revisions',
  fkColumn: 'page_id' | 'post_id',
): Promise<number> {
  const supabase = await getSupabase();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from(table)
    .select('id, draft_blocks')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .returns<DueRow[]>();

  if (error) throw error;
  if (!due?.length) return 0;

  let published = 0;
  for (const row of due) {
    // A row that fails validation here was scheduled with blocks that have
    // since become invalid (e.g. a block type removed from the catalog). It
    // is skipped rather than left to throw and take the rest of the batch
    // down with it — it stays 'scheduled' and shows up as visibly overdue in
    // the admin UI instead of silently vanishing.
    let blocks: unknown;
    try {
      blocks = validateBlocks(row.draft_blocks);
    } catch (err) {
      console.warn(`[scheduledPublish] ${table}.${row.id} has invalid draft_blocks, skipping`, err);
      continue;
    }

    const { error: updateError } = await supabase
      .from(table)
      .update({
        published_blocks: blocks,
        status: 'published',
        published_at: nowIso,
        scheduled_at: null,
        previous_status: null,
      })
      .eq('id', row.id);

    if (updateError) {
      console.error(`[scheduledPublish] ${table}.${row.id} failed to publish`, updateError);
      continue;
    }

    const { error: revisionError } = await supabase
      .from(revisionTable)
      .insert({ [fkColumn]: row.id, blocks, note: 'published (scheduled)' });
    if (revisionError) {
      console.warn(`[scheduledPublish] ${table}.${row.id} revision insert failed`, revisionError);
    }
    await pruneRevisions(revisionTable, fkColumn, row.id);

    published++;
  }

  return published;
}

export const publishDuePosts = (): Promise<number> =>
  publishDueRows('posts', 'post_revisions', 'post_id');

export const publishDuePages = (): Promise<number> =>
  publishDueRows('pages', 'page_revisions', 'page_id');
