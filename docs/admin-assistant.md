# Admin Assistant

A read-only chatbot at **/admin/assistant** that answers questions about the whole
platform: live data, how features work in code, payments, enrollments, logs, infra and
the Help Centre. Model: **Kimi K3 on Amazon Bedrock** (`global.moonshotai.kimi-k3`).

## What it can read

| Source | Tool(s) | How it is kept read-only |
|---|---|---|
| Supabase Postgres (`public`) | `query_db`, `describe_schema`, `search_help` | `hilom_assistant_ro` role: SELECT only, `default_transaction_read_only`, queried inside `begin read only`, one statement per call. 15 s statement timeout. |
| Help Centre (`kb_articles`) | `search_help` | same role |
| Code, migrations, CDK, docs | `list_files`, `search_code`, `read_file` | Snapshot of **git-tracked** files built at `cdk deploy`, stored as an S3 asset. `.env` and untracked files can never be in it. |
| CloudWatch logs (Hilom*) | `list_log_groups`, `query_logs` | IAM: Logs Insights read actions only |
| CloudFormation, SQS | `describe_infra`, `queue_depths` | IAM: Describe/List/GetQueueAttributes only |
| Moodle | `moodle_call` | Separate token (`hilom/assistant-moodle`) on the "Hilom Assistant (read-only)" service; only `get_*` functions; allowlisted again in code |
| PayMongo | `paymongo_lookup` | GET requests only, built in code |

**Hidden from the model:** any column whose name looks like a credential (`token`, `secret`,
`password`, `*_enc`, signature data, IP hashes), and the `facilitator_integrations` /
`facilitator_oauth_states` tables (revoked at the DB). PayMongo ids are shown as their last 6
characters. Customer names, emails and orders **are** visible, by decision (2026-10-03).

## Architecture

```
AssistantTab ──POST /admin/assistant/ask──▶ AdminAssistantFn ──Event invoke──▶ AdminAssistantWorkerFn
     │                                        (auth, writes run row)            (Bedrock Converse loop,
     └──GET /admin/assistant/runs/{id} (poll 1.5 s) ◀── assistant_runs.steps ──  tools, ≤30 turns, 10 min)
```

Async because a thorough answer takes 10–90 s and API Gateway cuts off at 30 s.

- Stack: `HilomAssistantStack` (`infra/lib/hilom-assistant-stack.ts`) — all of its IAM is in that file.
- Code: `backend/src/handlers/admin-assistant*.ts`, `backend/src/lib/assistant/`.
- Tables (0067): `assistant_conversations` (full model history for follow-ups),
  `assistant_runs` (question, who asked, every tool call incl. exact SQL, answer, tokens).
  **This is the audit trail.** Admins can permanently delete a conversation (trash icon in
  History), which deletes its runs too — by decision, 2026-10-03; deletions are logged to
  CloudWatch as `assistantConversationDeleted` with who did it. Auth: `isAdminCaller` — Cognito admin group or the shared admin key.

## Secrets

| Secret | Contents |
|---|---|
| `hilom/assistant-db` | `{ dbUrl }` — `hilom_assistant_ro.<ref>` on the session pooler |
| `hilom/assistant-moodle` | `{ url, token }` — read-only service token |

Rotate the DB password: `alter role hilom_assistant_ro password '…'` then update the secret.

## Operating

- **The code snapshot updates only on `cdk deploy HilomAssistantStack`**, not on a git push.
  Redeploy after significant changes so the assistant reads current code:
  `cd infra && npx cdk deploy HilomAssistantStack --exclusively`
- Try prompt/tool changes locally before deploying:
  `npx cdk synth HilomAssistantStack -q`, then
  `SNAPSHOT_FILE=infra/cdk.out/asset.<hash>.gz npx tsx scripts/assistant-ask.ts "question"`
- Usage/cost: `select date(created_at), count(*), sum(input_tokens), sum(output_tokens) from assistant_runs group by 1 order by 1 desc;`
- Switch model: change `ASSISTANT_MODEL_ID` in the stack (any Bedrock Converse model with tool use).
- Kimi K3 is a **global** inference profile: requests may be processed outside ap-southeast-1.
