/**
 * Ask the admin assistant a question from the terminal, with local AWS
 * credentials — for trying prompt or tool changes before a deploy.
 *
 *   cd infra && npx cdk synth HilomAssistantStack -q   # writes the code snapshot
 *   SNAPSHOT_FILE=infra/cdk.out/asset.<hash>.gz npx tsx scripts/assistant-ask.ts "How many orders are stuck?"
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAgent } from '../backend/src/lib/assistant/agent.js';

process.env.AWS_REGION ??= 'ap-southeast-1';
const question = process.argv.slice(2).join(' ');
if (!question) throw new Error('Usage: assistant-ask.ts "<question>"');

// Progress writes go nowhere locally; the real worker passes the service client.
const supabase = { from: () => ({ update: () => ({ eq: async () => ({}) }) }) } as unknown as SupabaseClient;
const started = Date.now();
const result = await runAgent({ supabase, runId: '00000000-0000-0000-0000-000000000000', history: [], question });
for (const m of result.messages) {
  for (const b of m.content ?? []) if (b.toolUse) console.error(`→ ${b.toolUse.name} ${JSON.stringify(b.toolUse.input).slice(0, 200)}`);
}
console.log(`\n${result.answer}\n`);
console.error(`${((Date.now() - started) / 1000).toFixed(1)}s, ${result.inputTokens} in / ${result.outputTokens} out tokens`);
