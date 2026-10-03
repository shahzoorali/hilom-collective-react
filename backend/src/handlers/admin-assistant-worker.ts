/**
 * Runs one admin-assistant question to completion. Invoked asynchronously
 * (InvocationType Event) by admin-assistant.ts with `{ runId }`; never routed
 * from API Gateway. See that file for why the split exists.
 *
 * Async Lambda invokes retry on failure, so the run is claimed with a
 * conditional update first: a retry of a run that already started is a no-op
 * rather than a second, duplicated answer.
 */
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { getSupabase } from '../lib/supabase.js';
import { runAgent, compactHistory } from '../lib/assistant/agent.js';

export async function handler(event: { runId: string }): Promise<void> {
  const supabase = await getSupabase();

  const { data: run } = await supabase
    .from('assistant_runs')
    .update({ status: 'running' })
    .eq('id', event.runId)
    .eq('status', 'queued')
    .select('id, conversation_id, question')
    .maybeSingle();
  if (!run) return;

  try {
    const { data: conv, error } = await supabase
      .from('assistant_conversations')
      .select('messages')
      .eq('id', run.conversation_id)
      .single();
    if (error) throw error;

    const result = await runAgent({
      supabase,
      runId: run.id,
      history: (conv.messages ?? []) as Message[],
      question: run.question,
    });

    await supabase
      .from('assistant_conversations')
      .update({ messages: compactHistory(result.messages), updated_at: new Date().toISOString() })
      .eq('id', run.conversation_id);
    await supabase
      .from('assistant_runs')
      .update({
        status: 'done',
        answer: result.answer,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id);
  } catch (err) {
    console.error('assistantWorker', err);
    await supabase
      .from('assistant_runs')
      .update({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id);
  }
}
