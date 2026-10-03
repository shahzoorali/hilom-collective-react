/**
 * The admin assistant's tools. Every one of them is read-only, and each is
 * read-only by construction rather than by instruction:
 *
 *   query_db / describe_schema / search_help / paymongo_lookup's row read
 *       → `hilom_assistant_ro`, a SELECT-only role whose transactions are
 *         read-only (0067), queried inside `begin read only`, one statement
 *         per call (extended protocol rejects `a; b`).
 *   list_files / search_code / read_file
 *       → a snapshot of the git-tracked repo, built at `cdk deploy` and stored
 *         as an S3 asset. Untracked files (.env) are never in it.
 *   list_log_groups / query_logs  → CloudWatch Logs read actions only (IAM).
 *   describe_infra / queue_depths → CloudFormation describe / SQS attributes (IAM).
 *   moodle_call   → a separate Moodle token whose service holds only get_* functions.
 *   paymongo_lookup → GET requests only; no code path here issues anything else.
 *
 * Results are size-capped so one wide query cannot blow the context window,
 * and passed through redactDeep before the model sees them.
 */
import pg from 'pg';
import { gunzipSync } from 'node:zlib';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { Tool, ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import { getSecret, getPayMongoSecret } from '../secrets.js';
import { redactDeep } from './redact.js';

const MAX_RESULT_CHARS = 40_000;
const MAX_ROWS = 200;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let pool: pg.Pool | undefined;

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  const { dbUrl } = await getSecret<{ dbUrl: string }>('hilom/assistant-db');
  // `sslmode=require` in the URL makes pg verify the chain, which fails on
  // the pooler's certificate from Lambda; encrypt without verifying, as the
  // URL's own sslmode intends.
  pool = new pg.Pool({
    connectionString: dbUrl.replace(/[?&]sslmode=[^&]*/, ''),
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 60_000,
  });
  return pool;
}

async function readOnlyQuery(sql: string, values: unknown[] = []) {
  const client = await (await getPool()).connect();
  try {
    await client.query('begin read only');
    // Extended protocol: exactly one statement, so `select 1; set ...` fails
    // to parse instead of running its second half.
    const res = await client.query({ text: sql, values, queryMode: 'extended' } as pg.QueryConfig);
    return res;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

const READ_STATEMENT = /^\s*(\(|select\b|with\b|explain\b|table\b|values\b)/i;

async function queryDb({ sql }: { sql: string }) {
  if (!READ_STATEMENT.test(sql)) {
    return { error: 'Only SELECT / WITH / EXPLAIN / TABLE / VALUES statements are allowed. This assistant is read-only.' };
  }
  if (/\bexplain\b[^;]*\banalyze\b/i.test(sql)) {
    return { error: 'EXPLAIN ANALYZE executes the statement; use plain EXPLAIN.' };
  }
  const res = await readOnlyQuery(sql);
  const rows = res.rows.slice(0, MAX_ROWS);
  return {
    rowCount: res.rowCount ?? res.rows.length,
    truncated: res.rows.length > MAX_ROWS,
    columns: res.fields.map((f) => f.name),
    rows: redactDeep(rows),
  };
}

async function describeSchema({ table }: { table?: string }) {
  if (!table) {
    const res = await readOnlyQuery(
      `select c.relname as table, c.reltuples::bigint as approx_rows,
              obj_description(c.oid) as comment
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','v','m')
          and has_table_privilege(c.oid, 'select')
        order by c.relname`,
    );
    return { tables: res.rows };
  }
  const cols = await readOnlyQuery(
    `select column_name, data_type, udt_name, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  );
  if (cols.rows.length === 0) return { error: `No readable table public.${table}` };
  const fks = await readOnlyQuery(
    `select pg_get_constraintdef(oid) as def, conname from pg_constraint
      where conrelid = ('public.' || quote_ident($1))::regclass and contype in ('f','c','u','p')`,
    [table],
  );
  const enums = await readOnlyQuery(
    `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
       from pg_type t join pg_enum e on e.enumtypid = t.oid
      where t.typname = any($1::text[]) group by t.typname`,
    [cols.rows.map((c) => c.udt_name)],
  );
  return { table, columns: cols.rows, constraints: fks.rows, enums: enums.rows };
}

async function searchHelp({ query }: { query: string }) {
  const res = await readOnlyQuery(
    `select a.slug, a.title, a.summary, a.audience, a.status, c.name as category,
            left(a.body, 6000) as body
       from kb_articles a left join kb_categories c on c.id = a.category_id
      where a.title ilike $1 or a.summary ilike $1 or a.body ilike $1 or $2 = any(a.tags)
      order by (a.title ilike $1) desc, a.updated_at desc nulls last
      limit 6`,
    [`%${query}%`, query.toLowerCase()],
  );
  return { articles: res.rows, note: 'Public URL of an article is https://www.hilomcollective.com/help/<slug>' };
}

// ---------------------------------------------------------------------------
// Code snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  builtAt: string;
  commit: string;
  files: Record<string, string>;
}
let snapshot: Snapshot | undefined;

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot) return snapshot;
  // Local runs (scripts/assistant-ask.ts) read the file the CDK synth writes.
  if (process.env.SNAPSHOT_FILE) {
    const { readFileSync } = await import('node:fs');
    snapshot = JSON.parse(gunzipSync(readFileSync(process.env.SNAPSHOT_FILE)).toString('utf8')) as Snapshot;
    return snapshot;
  }
  const s3 = new S3Client({});
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: process.env.SNAPSHOT_BUCKET, Key: process.env.SNAPSHOT_KEY }),
  );
  const bytes = await obj.Body!.transformToByteArray();
  snapshot = JSON.parse(gunzipSync(Buffer.from(bytes)).toString('utf8')) as Snapshot;
  return snapshot;
}

async function listFiles({ prefix = '' }: { prefix?: string }) {
  const snap = await getSnapshot();
  const paths = Object.keys(snap.files).filter((p) => p.startsWith(prefix));
  return { commit: snap.commit, builtAt: snap.builtAt, count: paths.length, paths: paths.slice(0, 500) };
}

async function searchCode({ pattern, path_prefix = '', max_results = 60 }: { pattern: string; path_prefix?: string; max_results?: number }) {
  const snap = await getSnapshot();
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const hits: { path: string; line: number; text: string }[] = [];
  for (const [path, content] of Object.entries(snap.files)) {
    if (!path.startsWith(path_prefix)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (re.test(line)) {
        hits.push({ path, line: i + 1, text: line.slice(0, 220) });
        if (hits.length >= Math.min(max_results, 200)) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}

async function readFile({ path, start_line = 1, end_line }: { path: string; start_line?: number; end_line?: number }) {
  const snap = await getSnapshot();
  const content = snap.files[path.replace(/^\.?\//, '')];
  if (content === undefined) return { error: `No such file in snapshot: ${path}. Use list_files or search_code.` };
  const lines = content.split('\n');
  const end = Math.min(end_line ?? start_line + 399, lines.length);
  const body = lines
    .slice(start_line - 1, end)
    .map((l, i) => `${start_line + i}\t${l}`)
    .join('\n');
  return { path, totalLines: lines.length, from: start_line, to: end, content: body };
}

// ---------------------------------------------------------------------------
// AWS: logs, stacks, queues
// ---------------------------------------------------------------------------

const logsClient = new CloudWatchLogsClient({});

async function hilomLogGroups(): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await logsClient.send(new DescribeLogGroupsCommand({ nextToken }));
    for (const g of res.logGroups ?? []) if (g.logGroupName && /hilom/i.test(g.logGroupName)) names.push(g.logGroupName);
    nextToken = res.nextToken;
  } while (nextToken);
  return names;
}

async function listLogGroups({ contains = '' }: { contains?: string }) {
  const all = await hilomLogGroups();
  return { logGroups: all.filter((n) => n.toLowerCase().includes(contains.toLowerCase())) };
}

async function queryLogs({ log_group_contains, query, hours_back = 24 }: { log_group_contains: string[]; query: string; hours_back?: number }) {
  const all = await hilomLogGroups();
  const groups = all.filter((n) => log_group_contains.some((c) => n.toLowerCase().includes(c.toLowerCase())));
  if (groups.length === 0) return { error: 'No matching Hilom log group. Call list_log_groups first.' };
  const hours = Math.min(Math.max(Number(hours_back) || 24, 1), 24 * 30);
  const end = Math.floor(Date.now() / 1000);
  const { queryId } = await logsClient.send(
    new StartQueryCommand({
      logGroupNames: groups.slice(0, 50),
      startTime: end - hours * 3600,
      endTime: end,
      queryString: query,
      limit: 100,
    }),
  );
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await logsClient.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete' || res.status === 'Failed' || res.status === 'Cancelled') {
      const rows = (res.results ?? []).map((row) =>
        Object.fromEntries(row.filter((f) => f.field !== '@ptr').map((f) => [f.field, f.value?.slice(0, 1500)])),
      );
      // The window is echoed so the model can't believe it searched a range it didn't.
      return {
        status: res.status,
        window: { hours, from: new Date((end - hours * 3600) * 1000).toISOString(), to: new Date(end * 1000).toISOString() },
        groupsSearched: groups,
        matched: res.statistics?.recordsMatched,
        rows,
      };
    }
  }
  return { error: 'Log query still running after 40s; narrow the time range or groups.' };
}

async function describeInfra({ stack }: { stack?: string }) {
  const cfn = new CloudFormationClient({});
  if (!stack) {
    const res = await cfn.send(new DescribeStacksCommand({}));
    return {
      region: process.env.AWS_REGION,
      stacks: (res.Stacks ?? [])
        .filter((s) => /hilom/i.test(s.StackName ?? ''))
        .map((s) => ({
          name: s.StackName,
          status: s.StackStatus,
          lastUpdated: s.LastUpdatedTime ?? s.CreationTime,
          description: s.Description,
          outputs: s.Outputs?.map((o) => ({ key: o.OutputKey, value: o.OutputValue })),
        })),
    };
  }
  if (!/hilom/i.test(stack)) return { error: 'Only Hilom stacks can be described.' };
  const resources: { logicalId?: string; type?: string; physicalId?: string; status?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const res = await cfn.send(new ListStackResourcesCommand({ StackName: stack, NextToken: nextToken }));
    for (const r of res.StackResourceSummaries ?? []) {
      if (r.ResourceType === 'AWS::ApiGatewayV2::Route' || r.ResourceType === 'AWS::Lambda::Permission') continue;
      resources.push({ logicalId: r.LogicalResourceId, type: r.ResourceType, physicalId: r.PhysicalResourceId, status: r.ResourceStatus });
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return { stack, note: 'API routes and Lambda permissions omitted for size; see infra/lib in the code.', resources };
}

async function queueDepths() {
  const sqs = new SQSClient({});
  const list = await sqs.send(new ListQueuesCommand({ MaxResults: 100 }));
  const out = [];
  for (const url of list.QueueUrls ?? []) {
    const a = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
      }),
    );
    out.push({ queue: url.split('/').pop(), ...a.Attributes });
  }
  return { queues: out };
}

// ---------------------------------------------------------------------------
// Moodle and PayMongo
// ---------------------------------------------------------------------------

const MOODLE_FUNCTIONS = [
  'core_course_get_courses',
  'core_course_get_courses_by_field',
  'core_user_get_users_by_field',
  'core_enrol_get_users_courses',
  'core_enrol_get_enrolled_users',
];

async function moodleCall({ function: fn, params = {} }: { function: string; params?: Record<string, string | number> }) {
  if (!MOODLE_FUNCTIONS.includes(fn)) return { error: `Not allowed. Allowed: ${MOODLE_FUNCTIONS.join(', ')}` };
  const { url, token } = await getSecret<{ url: string; token: string }>('hilom/assistant-moodle');
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' });
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  const res = await fetch(`${url}/webservice/rest/server.php`, { method: 'POST', body });
  return redactDeep(await res.json());
}

const PAYMONGO_PATHS: [RegExp, string][] = [
  [/^pay_/, 'payments'],
  [/^pi_/, 'payment_intents'],
  [/^cs_/, 'checkout_sessions'],
  [/^ref_/, 'refunds'],
];

async function paymongoLookup({ table, id }: { table: string; id: string }) {
  if (!/^[a-z_]+$/.test(table)) return { error: 'Bad table name' };
  const res = await readOnlyQuery(`select * from public.${table} where id::text = $1 limit 1`, [id]);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { error: `No ${table} row with id ${id}` };
  const ids = Object.entries(row)
    .filter(([k, v]) => /paymongo/i.test(k) && typeof v === 'string')
    .map(([, v]) => v as string);
  if (ids.length === 0) return { error: `${table} ${id} has no PayMongo ids recorded` };

  const { secretKey } = await getPayMongoSecret();
  const auth = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
  const objects = [];
  for (const pmId of ids) {
    const kind = PAYMONGO_PATHS.find(([re]) => re.test(pmId))?.[1];
    if (!kind) continue;
    const r = await fetch(`https://api.paymongo.com/v1/${kind}/${pmId}`, { headers: { Authorization: auth } });
    const json = (await r.json()) as { data?: { attributes?: Record<string, unknown> }; errors?: unknown };
    const attrs = json.data?.attributes ?? {};
    // Checkout sessions echo their whole line-item and payment list; keep the
    // fields an operator actually asks about.
    const { checkout_url: _u, client_key: _c, metadata: _m, ...rest } = attrs;
    objects.push({ kind, id: pmId, httpStatus: r.status, attributes: rest, errors: json.errors });
  }
  return redactDeep({ mode: process.env.PAYMONGO_SECRET_ID?.endsWith('live') ? 'live' : 'test', objects });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type Impl = (input: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

const obj = (properties: Record<string, unknown>, required: string[] = []): ToolInputSchema => ({
  json: { type: 'object', properties, required } as ToolInputSchema.JsonMember['json'],
});

export const TOOLS: { spec: Tool; impl: Impl; label: (i: any) => string }[] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
  {
    impl: queryDb,
    label: (i) => `SQL: ${String(i.sql).slice(0, 300)}`,
    spec: {
      toolSpec: {
        name: 'query_db',
        description:
          'Run ONE read-only PostgreSQL 17 (Supabase) query against the production database, schema public. SELECT/WITH/EXPLAIN only. Max 200 rows returned; aggregate or LIMIT. Money columns are integer centavos (PHP). Timestamps are UTC; Hilom operates in Asia/Manila (UTC+8). Secret columns come back as [hidden] and PayMongo ids as their last 6 chars.',
        inputSchema: obj({ sql: { type: 'string' } }, ['sql']),
      },
    },
  },
  {
    impl: describeSchema,
    label: (i) => (i.table ? `Schema: ${i.table}` : 'Schema: list tables'),
    spec: {
      toolSpec: {
        name: 'describe_schema',
        description: 'Without `table`: list all readable tables with approximate row counts. With `table`: its columns, types, constraints, foreign keys and enum values. Use before writing SQL against an unfamiliar table.',
        inputSchema: obj({ table: { type: 'string' } }),
      },
    },
  },
  {
    impl: searchHelp,
    label: (i) => `Help Centre: "${i.query}"`,
    spec: {
      toolSpec: {
        name: 'search_help',
        description: 'Search the Help Centre (/help knowledge base articles, written for clients, facilitators and admins) by keyword. Returns title, audience, status and body. Prefer this first for "how do I…" questions about using the product.',
        inputSchema: obj({ query: { type: 'string', description: 'A single keyword or short phrase' } }, ['query']),
      },
    },
  },
  {
    impl: listFiles,
    label: (i) => `Files: ${i.prefix || '/'}`,
    spec: {
      toolSpec: {
        name: 'list_files',
        description: 'List files in the repo snapshot (git-tracked files at deploy time). Top-level dirs: frontend/src (React admin + storefront), backend/src/handlers (Lambda per API area), backend/src/lib (domain logic), infra/lib (CDK stacks), db/migrations (SQL schema history), docs (runbooks/plans), scripts.',
        inputSchema: obj({ prefix: { type: 'string', description: 'Path prefix, e.g. backend/src/lib/' } }),
      },
    },
  },
  {
    impl: searchCode,
    label: (i) => `Search code: /${i.pattern}/ ${i.path_prefix ?? ''}`,
    spec: {
      toolSpec: {
        name: 'search_code',
        description: 'Case-insensitive regex search over the repo snapshot. Returns path:line hits.',
        inputSchema: obj(
          {
            pattern: { type: 'string' },
            path_prefix: { type: 'string' },
            max_results: { type: 'integer' },
          },
          ['pattern'],
        ),
      },
    },
  },
  {
    impl: readFile,
    label: (i) => `Read: ${i.path}${i.start_line ? `:${i.start_line}` : ''}`,
    spec: {
      toolSpec: {
        name: 'read_file',
        description: 'Read a file from the repo snapshot with line numbers (up to 400 lines per call).',
        inputSchema: obj(
          { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
          ['path'],
        ),
      },
    },
  },
  {
    impl: listLogGroups,
    label: (i) => `Log groups: ${i.contains ?? ''}`,
    spec: {
      toolSpec: {
        name: 'list_log_groups',
        description: 'List the Hilom Lambda CloudWatch log groups (one per function, e.g. ...CheckoutFnLogs..., ...PayMongoWebhookFn...). Filter by substring.',
        inputSchema: obj({ contains: { type: 'string' } }),
      },
    },
  },
  {
    impl: queryLogs,
    label: (i) => `Logs (${(i.log_group_contains ?? []).join(', ')}, ${i.hours_back ?? 24}h): ${String(i.query).slice(0, 200)}`,
    spec: {
      toolSpec: {
        name: 'query_logs',
        description: 'Run a CloudWatch Logs Insights query over Hilom log groups whose names contain any of the given substrings. Example query: "fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 50". Retention is 30 days.',
        inputSchema: obj(
          {
            log_group_contains: { type: 'array', items: { type: 'string' } },
            query: { type: 'string' },
            hours_back: { type: 'integer', description: 'How far back to search, in hours. 24 = one day, 168 = one week, 720 = 30 days (the maximum; logs are kept 30 days).' },
          },
          ['log_group_contains', 'query', 'hours_back'],
        ),
      },
    },
  },
  {
    impl: describeInfra,
    label: (i) => `Infra: ${i.stack ?? 'stacks'}`,
    spec: {
      toolSpec: {
        name: 'describe_infra',
        description: 'Without `stack`: status, last deploy time and outputs of every deployed Hilom CloudFormation stack. With `stack`: its resources (Lambdas, buckets, queues, secrets...) and physical ids.',
        inputSchema: obj({ stack: { type: 'string' } }),
      },
    },
  },
  {
    impl: queueDepths,
    label: () => 'SQS queue depths',
    spec: {
      toolSpec: {
        name: 'queue_depths',
        description: 'Message counts for every SQS queue, including the enrollment retry queue and its dead-letter queue. A non-empty DLQ means fulfillment gave up on something.',
        inputSchema: obj({}),
      },
    },
  },
  {
    impl: moodleCall,
    label: (i) => `Moodle: ${i.function}`,
    spec: {
      toolSpec: {
        name: 'moodle_call',
        description: `Call a read-only Moodle web-service function on https://www.learn.hilomcollective.com. Allowed: ${MOODLE_FUNCTIONS.join(', ')}. Params are Moodle's flat form encoding, e.g. core_user_get_users_by_field {"field":"email","values[0]":"a@b.com"}; core_enrol_get_users_courses {"userid":42}; core_enrol_get_enrolled_users {"courseid":10}; core_course_get_courses_by_field {"field":"id","value":10}.`,
        inputSchema: obj(
          { function: { type: 'string' }, params: { type: 'object' } },
          ['function'],
        ),
      },
    },
  },
  {
    impl: paymongoLookup,
    label: (i) => `PayMongo: ${i.table} ${i.id}`,
    spec: {
      toolSpec: {
        name: 'paymongo_lookup',
        description: "Fetch the live PayMongo records (payment, payment intent, checkout session, refund) for a row that stores PayMongo ids — e.g. table 'orders', 'event_registrations', 'registration_charges', 'bookings', 'class_registrations' — by that row's id (uuid). GET only.",
        inputSchema: obj({ table: { type: 'string' }, id: { type: 'string' } }, ['table', 'id']),
      },
    },
  },
];

export async function runTool(name: string, input: unknown): Promise<string> {
  const tool = TOOLS.find((t) => t.spec.toolSpec?.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool ${name}` });
  let result: unknown;
  try {
    result = await tool.impl(input ?? {});
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  const text = JSON.stringify(result);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated ${text.length - MAX_RESULT_CHARS} chars; narrow the request]`
    : text;
}

export function toolLabel(name: string, input: unknown): string {
  const tool = TOOLS.find((t) => t.spec.toolSpec?.name === name);
  try {
    return tool ? tool.label(input ?? {}) : name;
  } catch {
    return name;
  }
}

export async function readFileFromSnapshot(path: string): Promise<string | undefined> {
  return (await getSnapshot()).files[path];
}

export async function snapshotInfo(): Promise<{ commit: string; builtAt: string }> {
  const { commit, builtAt } = await getSnapshot();
  return { commit, builtAt };
}
