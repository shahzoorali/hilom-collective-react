import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const BACKEND_SRC = path.join(REPO_ROOT, 'backend', 'src');

export interface HilomBackendStackProps extends cdk.StackProps {
  /**
   * ACM certificate for api.hilomcollective.com. Must live in this stack's
   * region (ap-southeast-1) — unlike the CloudFront/Amplify certificate, which
   * has to be in us-east-1.
   *
   * Left undefined until DNS validation completes, in which case the API is
   * deployed without a custom domain and is still reachable at its execute-api
   * URL. This keeps the stack deployable while a DNS record propagates.
   */
  readonly apiCertificateArn?: string;

  /** Allowed browser origin for CORS. */
  readonly corsOrigin?: string;
}

export class HilomBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HilomBackendStackProps = {}) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Secrets. These are created outside CDK (they hold real credentials that
    // must not live in a template), so they are imported by name.
    // ---------------------------------------------------------------------
    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(this, 'SupabaseSecret', 'hilom/supabase');
    const moodleSecret = secretsmanager.Secret.fromSecretNameV2(this, 'MoodleSecret', 'hilom/moodle');
    const paymongoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'PayMongoSecret', 'hilom/paymongo/test');

    // The admin key has no external source of truth, so CDK generates it. It is
    // never rendered into the template — only the generated secret's ARN is.
    const adminKeySecret = new secretsmanager.Secret(this, 'AdminApiKey', {
      secretName: 'hilom/admin-api-key',
      description: 'Shared key for /admin/* endpoints until Cognito admin groups land in Phase 7',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'key',
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    // ---------------------------------------------------------------------
    // Lambdas
    // ---------------------------------------------------------------------
    const makeFn = (id: string, entry: string, handler: string): nodejs.NodejsFunction => {
      // An explicit log group, rather than the deprecated `logRetention` prop,
      // which provisions a custom resource Lambda just to set retention.
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      return new nodejs.NodejsFunction(this, id, {
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
          CORS_ORIGIN: props.corsOrigin ?? '*',
          ADMIN_KEY_SECRET_ID: adminKeySecret.secretName,
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
          banner:
            "import{createRequire}from'module';const require=createRequire(import.meta.url);",
        },
      });
    };

    const productsList = makeFn('ProductsListFn', 'handlers/products.ts', 'list');
    const productsDetail = makeFn('ProductsDetailFn', 'handlers/products.ts', 'detail');
    const coursesList = makeFn('CoursesListFn', 'handlers/courses.ts', 'list');
    const syncCourses = makeFn('SyncCoursesFn', 'handlers/admin.ts', 'syncCourses');
    const retryEnrollment = makeFn('RetryEnrollmentFn', 'handlers/admin.ts', 'retryEnrollment');
    const paymongoWebhook = makeFn('PayMongoWebhookFn', 'handlers/paymongo-webhook.ts', 'handler');

    // Least privilege: only the functions that read a given secret can read it.
    for (const fn of [productsList, productsDetail, coursesList, syncCourses, retryEnrollment]) {
      supabaseSecret.grantRead(fn);
    }
    moodleSecret.grantRead(syncCourses);
    paymongoSecret.grantRead(paymongoWebhook);
    supabaseSecret.grantRead(paymongoWebhook);
    adminKeySecret.grantRead(syncCourses);
    adminKeySecret.grantRead(retryEnrollment);

    // ---------------------------------------------------------------------
    // HTTP API
    // ---------------------------------------------------------------------
    let domainName: apigw.DomainName | undefined;
    if (props.apiCertificateArn) {
      domainName = new apigw.DomainName(this, 'ApiDomain', {
        domainName: 'api.hilomcollective.com',
        certificate: acm.Certificate.fromCertificateArn(this, 'ApiCert', props.apiCertificateArn),
      });
    }

    const httpApi = new apigw.HttpApi(this, 'HilomHttpApi', {
      apiName: 'hilom-api',
      description: 'Hilom Collective public + admin API',
      corsPreflight: {
        allowOrigins: [props.corsOrigin ?? '*'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'x-admin-key', 'authorization'],
        maxAge: cdk.Duration.hours(1),
      },
      ...(domainName
        ? { defaultDomainMapping: { domainName } }
        : {}),
    });

    const route = (
      routePath: string,
      method: apigw.HttpMethod,
      fn: nodejs.NodejsFunction,
      id: string,
    ): void => {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new integrations.HttpLambdaIntegration(id, fn),
      });
    };

    route('/products', apigw.HttpMethod.GET, productsList, 'ProductsListInt');
    route('/products/{slug}', apigw.HttpMethod.GET, productsDetail, 'ProductsDetailInt');
    route('/courses', apigw.HttpMethod.GET, coursesList, 'CoursesListInt');
    route('/admin/sync-courses', apigw.HttpMethod.POST, syncCourses, 'SyncCoursesInt');
    route('/admin/retry-enrollment/{orderId}', apigw.HttpMethod.POST, retryEnrollment, 'RetryEnrollmentInt');
    route('/webhooks/paymongo', apigw.HttpMethod.POST, paymongoWebhook, 'PayMongoWebhookInt');

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'execute-api URL (works regardless of custom domain state)',
    });

    if (domainName) {
      // This is the value that goes in the GoDaddy CNAME for api.hilomcollective.com.
      new cdk.CfnOutput(this, 'ApiDomainTarget', {
        value: domainName.regionalDomainName,
        description: 'CNAME target for api.hilomcollective.com at GoDaddy',
      });
    }

    new cdk.CfnOutput(this, 'AdminApiKeySecretArn', {
      value: adminKeySecret.secretArn,
      description: 'Read the generated admin key from here; it is never printed',
    });
  }
}
