/**
 * Admin assistant: a read-only chatbot in the admin panel (Kimi K3 on Bedrock)
 * that can read the database, the code, the logs, the deployed stacks, Moodle
 * and PayMongo. See docs/admin-assistant.md.
 *
 * Its own stack because its IAM surface is unusual — read access across logs,
 * CloudFormation and SQS — and keeping that in one place makes it easy to
 * audit what the assistant can touch: everything it is granted is in this
 * file, and every grant is a read.
 *
 * Two functions:
 *   AdminAssistantFn       API: ask / poll / history. Fast; 30 s like the rest.
 *   AdminAssistantWorkerFn Runs the agent loop. Invoked async, 10-minute timeout.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ADMIN_KEY_SECRET_NAME,
  DEFAULT_COGNITO_SPA_CLIENT_ID,
  DEFAULT_COGNITO_USER_POOL_ID,
  REPO_ROOT,
  lambdaFactory,
  routeAttacher,
  type HilomCommonProps,
} from './hilom-shared';

export interface HilomAssistantStackProps extends HilomCommonProps {
  readonly httpApiId: string;
}

export const ASSISTANT_MODEL_ID = 'global.moonshotai.kimi-k3';

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|sql|md|css|html|php|sh|yml|yaml|toml|txt)$/i;
const SKIP = /(^|\/)(package-lock\.json|node_modules\/|dist\/|cdk\.out\/)|\.d\.ts$|^infra\/(bin|lib)\/.*\.js$/;
const MAX_FILE_BYTES = 400_000;

/**
 * Packs every git-tracked text file into one gzipped JSON document.
 *
 * `git ls-files`, not a directory walk, is the security boundary: `.env` and
 * anything else gitignored can never end up in front of the model. Built at
 * synth, so the assistant's view of the code is the code that was deployed.
 */
export function buildCodeSnapshot(): string {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((p) => p && TEXT_FILE.test(p) && !SKIP.test(p));
  const files: Record<string, string> = {};
  for (const rel of tracked) {
    const abs = path.join(REPO_ROOT, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.size <= MAX_FILE_BYTES) files[rel] = fs.readFileSync(abs, 'utf8');
    } catch {
      // Deleted in the working tree but not yet committed.
    }
  }
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hilom-snapshot-'));
  const out = path.join(dir, 'code-snapshot.json.gz');
  fs.writeFileSync(out, gzipSync(JSON.stringify({ commit, builtAt: new Date().toISOString(), files })));
  return out;
}

export class HilomAssistantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HilomAssistantStackProps) {
    super(scope, id, props);

    const makeFn = lambdaFactory(this, {
      corsOrigin: props.corsOrigin ?? '*',
      adminKeySecretName: ADMIN_KEY_SECRET_NAME,
    });

    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(this, 'SupabaseSecret', 'hilom/supabase');
    const adminKeySecret = secretsmanager.Secret.fromSecretNameV2(this, 'AdminApiKey', ADMIN_KEY_SECRET_NAME);
    const assistantDbSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AssistantDbSecret', 'hilom/assistant-db');
    const assistantMoodleSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AssistantMoodleSecret', 'hilom/assistant-moodle');
    const paymongoSecretId = props.paymongoSecretId ?? 'hilom/paymongo/test';
    const paymongoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'PayMongoSecret', paymongoSecretId);

    const api = makeFn('AdminAssistantFn', 'handlers/admin-assistant.ts', 'handler');
    const worker = makeFn('AdminAssistantWorkerFn', 'handlers/admin-assistant-worker.ts', 'handler');
    // The agent loop: up to 30 model turns plus log queries that poll for 40 s.
    (worker.node.defaultChild as lambda.CfnFunction).timeout = 600;
    (worker.node.defaultChild as lambda.CfnFunction).memorySize = 1024;

    // ---- API function: auth + run bookkeeping only ----
    supabaseSecret.grantRead(api);
    adminKeySecret.grantRead(api);
    worker.grantInvoke(api);
    api.addEnvironment('ASSISTANT_WORKER_FN', worker.functionName);
    api.addEnvironment('COGNITO_USER_POOL_ID', props.cognitoUserPoolId ?? DEFAULT_COGNITO_USER_POOL_ID);
    api.addEnvironment('COGNITO_SPA_CLIENT_ID', props.cognitoSpaClientId ?? DEFAULT_COGNITO_SPA_CLIENT_ID);

    // ---- worker: every grant below is a read ----
    // Service-role Supabase only to write its own run/conversation rows; every
    // query the *model* asks for goes through hilom/assistant-db, the
    // SELECT-only role (0067).
    supabaseSecret.grantRead(worker);
    assistantDbSecret.grantRead(worker);
    assistantMoodleSecret.grantRead(worker);
    paymongoSecret.grantRead(worker);
    worker.addEnvironment('PAYMONGO_SECRET_ID', paymongoSecretId);
    worker.addEnvironment('ASSISTANT_MODEL_ID', ASSISTANT_MODEL_ID);

    const snapshot = new s3assets.Asset(this, 'CodeSnapshot', { path: buildCodeSnapshot() });
    snapshot.grantRead(worker);
    worker.addEnvironment('SNAPSHOT_BUCKET', snapshot.s3BucketName);
    worker.addEnvironment('SNAPSHOT_KEY', snapshot.s3ObjectKey);

    // A global cross-region inference profile: the request is accepted here
    // and may be served from any commercial region, so the underlying model
    // must be allowed in every region.
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${ASSISTANT_MODEL_ID}`,
          'arn:aws:bedrock:*::foundation-model/moonshotai.kimi-k3*',
          'arn:aws:bedrock:::foundation-model/moonshotai.kimi-k3*',
        ],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StopQuery'],
        resources: ['*'],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:StartQuery', 'logs:FilterLogEvents', 'logs:GetLogEvents'],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:Hilom*`,
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/Hilom*`,
        ],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'],
        resources: ['*'],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:ListQueues', 'sqs:GetQueueAttributes'],
        resources: ['*'],
      }),
    );

    const httpApi = apigw.HttpApi.fromHttpApiAttributes(this, 'HilomHttpApi', { httpApiId: props.httpApiId });
    const attach = routeAttacher(this, httpApi);
    const { GET, POST, DELETE } = apigw.HttpMethod;
    attach(api, 'AdminAssistantInt', [
      ['/admin/assistant/ask', [POST]],
      ['/admin/assistant/conversations', [GET]],
      ['/admin/assistant/conversations/{conversationId}', [GET, DELETE]],
      ['/admin/assistant/runs/{runId}', [GET]],
    ]);
  }
}
