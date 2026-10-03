/**
 * Admin → Assistant: a read-only chatbot over the database, code, logs, infra,
 * Moodle, PayMongo and the Help Centre. See docs/admin-assistant.md.
 *
 *   POST /admin/assistant/ask                      { question, conversationId? } → { runId, conversationId }
 *   GET  /admin/assistant/runs/{runId}             one run: status, live steps, answer
 *   GET  /admin/assistant/conversations            the 50 most recent conversations
 *   GET  /admin/assistant/conversations/{id}       a conversation's runs, oldest first
 *
 * Asking is asynchronous: an answer that reads the schema, runs three queries
 * and searches the logs routinely takes longer than API Gateway's 30-second
 * ceiling, so this function records the run and hands it to the worker
 * (admin-assistant-worker.ts) with an Event invoke; the browser polls the run.
 *
 * Every question is stored with who asked it, and every tool call — the SQL
 * text, the log query, the file read — is stored on the run's `steps`. That is
 * the audit trail; there is no separate audit-log entry because nothing here
 * changes state.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getSupabase } from '../lib/supabase.js';
import { ok, badRequest, unauthorized, notFound, serverError, isAdminCaller } from '../lib/http.js';
import { adminActorFromEvent } from '../lib/audit.js';

const lambda = new LambdaClient({});
const MAX_QUESTION = 8000;
const UUID = /^[0-9a-f-]{36}$/i;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!(await isAdminCaller(event))) return unauthorized();

  const method = event.requestContext.http.method;
  const path = event.rawPath;
  try {
    const supabase = await getSupabase();

    if (method === 'POST' && path.endsWith('/admin/assistant/ask')) {
      const body = JSON.parse(event.body ?? '{}') as { question?: string; conversationId?: string };
      const question = (body.question ?? '').trim();
      if (!question) return badRequest('question is required');
      if (question.length > MAX_QUESTION) return badRequest(`question is limited to ${MAX_QUESTION} characters`);

      const actor = await adminActorFromEvent(event);
      let conversationId = body.conversationId;
      if (conversationId) {
        if (!UUID.test(conversationId)) return badRequest('bad conversationId');
        const { data } = await supabase.from('assistant_conversations').select('id').eq('id', conversationId).maybeSingle();
        if (!data) return notFound('Conversation not found');
        const { data: busy } = await supabase
          .from('assistant_runs')
          .select('id')
          .eq('conversation_id', conversationId)
          .in('status', ['queued', 'running'])
          .limit(1);
        if (busy?.length) return badRequest('Still answering the previous question in this conversation');
      } else {
        const { data, error } = await supabase
          .from('assistant_conversations')
          .insert({ actor_source: actor.source, actor_label: actor.label, title: question.slice(0, 80) })
          .select('id')
          .single();
        if (error) throw error;
        conversationId = data.id as string;
      }

      const { data: run, error } = await supabase
        .from('assistant_runs')
        .insert({ conversation_id: conversationId, actor_source: actor.source, actor_label: actor.label, question })
        .select('id')
        .single();
      if (error) throw error;

      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.ASSISTANT_WORKER_FN,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ runId: run.id })),
        }),
      );
      return ok({ runId: run.id, conversationId });
    }

    if (method === 'GET' && path.endsWith('/admin/assistant/conversations')) {
      const { data, error } = await supabase
        .from('assistant_conversations')
        .select('id, title, actor_label, actor_source, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return ok({ conversations: data });
    }

    const conv = path.match(/\/admin\/assistant\/conversations\/([^/]+)$/);
    if (method === 'GET' && conv) {
      if (!UUID.test(conv[1]!)) return badRequest('bad id');
      const { data, error } = await supabase
        .from('assistant_runs')
        .select('id, question, status, steps, answer, error, actor_label, created_at, finished_at')
        .eq('conversation_id', conv[1]!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return ok({ runs: data });
    }

    const run = path.match(/\/admin\/assistant\/runs\/([^/]+)$/);
    if (method === 'GET' && run) {
      if (!UUID.test(run[1]!)) return badRequest('bad id');
      const { data, error } = await supabase
        .from('assistant_runs')
        .select('id, conversation_id, question, status, steps, answer, error, input_tokens, output_tokens, created_at, finished_at')
        .eq('id', run[1]!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return notFound();
      return ok({ run: data });
    }

    return badRequest(`Unsupported ${method} ${path}`);
  } catch (err) {
    return serverError('adminAssistant', err);
  }
}
