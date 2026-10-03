/**
 * Admin assistant API (backend/src/handlers/admin-assistant.ts).
 *
 * Sends the Cognito id_token alongside the admin key when there is one, so a
 * signed-in admin's questions are attributed to their verified email rather
 * than to the shared key.
 */
import { apiFetch } from './api';
import { idToken } from './auth';
import { adminActor } from './cms';

export interface AssistantStep {
  tool: string;
  label: string;
  ok: boolean;
  ms: number;
  preview: string;
}

export interface AssistantRun {
  id: string;
  conversation_id?: string;
  question: string;
  status: 'queued' | 'running' | 'done' | 'error';
  steps: AssistantStep[];
  answer: string | null;
  error: string | null;
  actor_label?: string;
  created_at: string;
  finished_at: string | null;
}

export interface AssistantConversation {
  id: string;
  title: string;
  actor_label: string;
  actor_source: string;
  created_at: string;
  updated_at: string;
}

const init = (adminKey: string, body?: unknown, method?: string): RequestInit => {
  const token = idToken();
  const actor = adminActor();
  return {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'x-admin-key': adminKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(actor ? { 'x-admin-actor': actor } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
};

export const askAssistant = (adminKey: string, question: string, conversationId?: string) =>
  apiFetch<{ runId: string; conversationId: string }>(
    '/admin/assistant/ask',
    init(adminKey, { question, conversationId }),
  );

export const getAssistantRun = (adminKey: string, runId: string) =>
  apiFetch<{ run: AssistantRun }>(`/admin/assistant/runs/${runId}`, init(adminKey)).then((r) => r.run);

export const listAssistantConversations = (adminKey: string) =>
  apiFetch<{ conversations: AssistantConversation[] }>('/admin/assistant/conversations', init(adminKey)).then(
    (r) => r.conversations,
  );

export const getAssistantConversation = (adminKey: string, id: string) =>
  apiFetch<{ runs: AssistantRun[] }>(`/admin/assistant/conversations/${id}`, init(adminKey)).then((r) => r.runs);

/** Permanent: the conversation and every run in it, including their audit steps. */
export const deleteAssistantConversation = (adminKey: string, id: string) =>
  apiFetch<{ deleted: string }>(`/admin/assistant/conversations/${id}`, init(adminKey, undefined, 'DELETE'));
