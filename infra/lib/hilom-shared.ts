/**
 * Pieces shared by the three Hilom stacks.
 *
 * The backend used to be one stack. It hit CloudFormation's hard ceiling of
 * 500 resources per stack — 63% of which is API Gateway wiring, three
 * resources (route + integration + invoke permission) for every endpoint — so
 * it is now three: core, CMS, and marketplace.
 *
 * **The one rule that matters when editing any of them.** A resource's logical
 * id is derived from its construct path, and CloudFormation replaces anything
 * whose logical id changes. For a Lambda that is free; for the media bucket,
 * the CloudFront distribution, the admin key or a Cognito group it means
 * losing images, breaking every stored CDN url, rotating a key nobody wrote
 * down, or wiping facilitator group membership. That is why `lambdaFactory`
 * takes the *stack* as its scope and creates children directly on it rather
 * than under a tidy nested construct: `HilomCoreStack` keeps the construct ids
 * the single stack used, so every resource that stayed behind kept its logical
 * id and was never touched by the split.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';

export const REPO_ROOT = path.join(__dirname, '..', '..');
export const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');

/**
 * Created by the core stack, read by name everywhere else.
 *
 * The CMS and marketplace stacks import it with `fromSecretNameV2` rather than
 * receiving the Secret object across the stack boundary. Both produce the same
 * IAM grant, but importing by name avoids a CloudFormation export — and an
 * export, once something consumes it, cannot be changed or removed until every
 * consumer stops using it. Not worth spending that on a constant.
 */
export const ADMIN_KEY_SECRET_NAME = 'hilom/admin-api-key';

export const DEFAULT_COGNITO_USER_POOL_ID = 'ap-southeast-1_AA9IeeZ2z';
export const DEFAULT_COGNITO_SPA_CLIENT_ID = '29bo0gpj7j9u7ofbcii22emj8l';
export const DEFAULT_ALERT_EMAIL = 'don.poky@gmail.com';
export const DEFAULT_FRONTEND_URL = 'https://www.hilomcollective.com';
export const DEFAULT_CHECKOUT_PAYMENT_METHODS = 'qrph';

/**
 * Event ids whose registration-confirmed email carries the participant
 * agreement PDF (backend/src/lib/participant-agreement.ts). Comma-separated.
 * Just the Return to Self retreat today; a course confirmation must never get
 * a retreat waiver, so this is an explicit allowlist rather than "any event
 * with consent text".
 */
export const DEFAULT_PARTICIPANT_AGREEMENT_EVENT_IDS = '780002bf-573e-47c0-a77c-c5f32f9f20dd';

/**
 * SES sends from Mumbai, not this stack's Singapore: hilomcollective.com is
 * already a verified, DKIM-signed domain identity there with production
 * access, so no new identity or DNS work was needed.
 */
export const SES_REGION = 'ap-south-1';

/** Props every Hilom stack accepts, so `bin/infra.ts` can thread one object. */
export interface HilomCommonProps extends cdk.StackProps {
  /** Allowed browser origin for CORS. */
  readonly corsOrigin?: string;

  /**
   * Cognito user pool ID that checkout fulfillment admin-creates buyers in.
   * Not secret (unlike the app client secret, which lives in hilom/cognito) —
   * only used to scope the Lambdas' IAM policy to this one pool.
   */
  readonly cognitoUserPoolId?: string;

  /**
   * Public SPA app client id (the PKCE one the browser uses) — the audience
   * buyer id_tokens are validated against. Deliberately not the
   * `hilom-moodle` client, which holds a secret and is only used server-side
   * by Moodle's `auth_oauth2`. Public by nature: it ships in the JS bundle.
   */
  readonly cognitoSpaClientId?: string;

  /** Where the DLQ alarm and admin alerts are sent. */
  readonly alertEmail?: string;

  /**
   * Comma-separated PayMongo payment method types the hosted checkout offers.
   * Defaults to `qrph`, the only method activated on the account. Every value
   * must be activated in PayMongo or session creation fails with a 400.
   */
  readonly checkoutPaymentMethods?: string;

  /**
   * Where PayMongo's hosted checkout redirects back to. Must be the `www`
   * host: the bare apex only 301s the root path to www, and 404s every other
   * path via a separate redirect microservice rather than reaching the app.
   */
  readonly frontendUrl?: string;

  /**
   * Comma-separated event ids whose confirmation email attaches the
   * participant agreement PDF. Defaults to the Return to Self retreat.
   */
  readonly participantAgreementEventIds?: string;

  /**
   * Which PayMongo credential set the checkout/webhook/order-status functions
   * read — `hilom/paymongo/test` or `hilom/paymongo/live`. Defaults to test so
   * a bare `cdk deploy` can never accidentally start taking real payments;
   * going live is an explicit context flag
   * (`-c paymongoSecretId=hilom/paymongo/live`), not a default that silently
   * flips once the live secret happens to exist.
   *
   * The grant and the `PAYMONGO_SECRET_ID` env var must always travel
   * together: the grant alone controls nothing at runtime, so a function with
   * the grant but no env var silently reads the *test* secret while holding a
   * live grant.
   */
  readonly paymongoSecretId?: string;
}

export type MakeFn = (id: string, entry: string, handler: string) => nodejs.NodejsFunction;

/**
 * The Lambda constructor every stack uses.
 *
 * `scope` must be the stack itself — see the logical-id note at the top of
 * this file. Passing anything else silently renames every function in that
 * stack, which for the core stack means replacing production infrastructure.
 */
export function lambdaFactory(
  scope: Construct,
  opts: { corsOrigin: string; adminKeySecretName: string },
): MakeFn {
  return (id, entry, handler) => {
    // An explicit log group, rather than the deprecated `logRetention` prop,
    // which provisions a custom resource Lambda just to set retention.
    const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    return new nodejs.NodejsFunction(scope, id, {
      entry: path.join(BACKEND_SRC, entry),
      handler,
      // The Lambda sources live in the backend workspace, not under infra/.
      // Without these, bundling rejects an entry outside the CDK project root
      // and cannot find the hoisted lockfile.
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      // Node 20 was deprecated 2026-04-30; new-function creation stops 2027-02-01.
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // cheaper per ms than x86
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // Logs are the only way to diagnose a failed enrollment, but they are
      // not worth paying to store forever at this volume.
      logGroup,
      environment: {
        CORS_ORIGIN: opts.corsOrigin,
        ADMIN_KEY_SECRET_ID: opts.adminKeySecretName,
        // Avoids each cold start paying for the SDK's region lookup.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        // Top-level await in ESM output requires this banner workaround for
        // esbuild's CJS interop shims.
        banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
        // `import pdf from './x.pdf'` -> a Uint8Array of the file's bytes,
        // embedded in the bundle. Only registration-fulfillment does this, for
        // the participant-agreement attachment; see backend/src/lib/mime.ts.
        loader: { '.pdf': 'binary' },
      },
    });
  };
}

/** One function's routes: `['/admin/pages', [GET, POST]]`. */
export type RouteEntry = [string, apigw.HttpMethod[]];

export type AttachRoutes = (
  fn: nodejs.NodejsFunction,
  integrationId: string,
  entries: RouteEntry[],
) => void;

/**
 * Attaches routes to an HTTP API this stack does not own.
 *
 * `HttpApi.addRoutes()` only exists on the concrete class, and the CMS and
 * marketplace stacks hold an imported `IHttpApi` — so routes are built with
 * `HttpRoute` directly. One `HttpLambdaIntegration` instance is shared across
 * a function's entries: the integration caches itself on first bind, so all of
 * a function's routes point at a single integration resource instead of one
 * each. That is worth roughly 100 resources across the API.
 *
 * **Route ordering is a readability convention here, not a routing rule.**
 * HTTP APIs always prefer the more specific match, so `/admin/pages/trash`
 * beats `/admin/pages/{pageId}` regardless of declaration order — and, since
 * the split, regardless of which stack declared it. Keeping literals listed
 * above their parameterised siblings just makes the intent legible.
 */
export function routeAttacher(scope: Construct, httpApi: apigw.IHttpApi): AttachRoutes {
  return (fn, integrationId, entries) => {
    const integration = new integrations.HttpLambdaIntegration(integrationId, fn);
    for (const [routePath, methods] of entries) {
      for (const method of methods) {
        new apigw.HttpRoute(scope, `${integrationId}${method}${routeSlug(routePath)}`, {
          httpApi,
          routeKey: apigw.HttpRouteKey.with(routePath, method),
          integration,
        });
      }
    }
  };
}

/**
 * `/admin/pages/{pageId}` → `adminpagesVarpageId`, for a construct id.
 *
 * Path parameters keep a `Var` marker so a literal segment can never collide
 * with a parameterised one of the same name.
 */
const routeSlug = (routePath: string): string =>
  routePath.replace(/\{/g, 'Var').replace(/[^A-Za-z0-9]/g, '');

/**
 * Permission to send through the Mumbai SES identity.
 *
 * Granted per function, so omitting one is a silent runtime failure rather
 * than a deploy error — which is exactly how a scheduled reminder job ends up
 * failing with AccessDenied where nobody is watching a response code.
 */
export const sesSendPolicy = (stack: cdk.Stack): iam.PolicyStatement =>
  new iam.PolicyStatement({
    actions: ['ses:SendEmail'],
    resources: [
      `arn:aws:ses:${SES_REGION}:${stack.account}:identity/hilomcollective.com`,
      // The domain identity has a default configuration set attached, so SES
      // checks permission on that resource too, not just the identity.
      `arn:aws:ses:${SES_REGION}:${stack.account}:configuration-set/default-config-set`,
    ],
  });
