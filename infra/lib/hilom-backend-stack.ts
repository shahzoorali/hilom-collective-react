import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
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

  /**
   * Cognito user pool ID that checkout fulfillment admin-creates buyers in.
   * Not secret (unlike the app client secret, which lives in hilom/cognito) —
   * only used here to scope the Lambdas' IAM policy to this one pool.
   */
  readonly cognitoUserPoolId?: string;

  /** Where the DLQ CloudWatch alarm sends its SNS notification. */
  readonly alertEmail?: string;
}

const DEFAULT_COGNITO_USER_POOL_ID = 'ap-southeast-1_AA9IeeZ2z';
const DEFAULT_ALERT_EMAIL = 'don.poky@gmail.com';

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
    const cognitoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'CognitoSecret', 'hilom/cognito');

    const cognitoUserPoolId = props.cognitoUserPoolId ?? DEFAULT_COGNITO_USER_POOL_ID;
    const cognitoUserPoolArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${cognitoUserPoolId}`;

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

    // ---------------------------------------------------------------------
    // Enrollment retry queue + DLQ + alert
    //
    // A failed fulfillment (Moodle down, transient DB error, etc.) must never
    // just vanish: the order stays `paid_pending_enrollment` and a message
    // goes here. SQS retries it up to maxReceiveCount times with the
    // Lambda's own backoff (throwing re-queues); once exhausted, the message
    // moves to the DLQ, which is what actually pages a human via SNS — a
    // failed *delivery* is expected and self-heals, a message reaching the
    // DLQ means it did not.
    // ---------------------------------------------------------------------
    const enrollmentRetryDlq = new sqs.Queue(this, 'EnrollmentRetryDlq', {
      queueName: 'hilom-enrollment-retry-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const enrollmentRetryQueue = new sqs.Queue(this, 'EnrollmentRetryQueue', {
      queueName: 'hilom-enrollment-retry',
      // >= 6x the consumer Lambda's timeout, per AWS's own guidance, so a
      // message can't become visible again mid-processing and be picked up
      // by a second concurrent invocation.
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: { queue: enrollmentRetryDlq, maxReceiveCount: 5 },
    });

    const alertTopic = new sns.Topic(this, 'EnrollmentAlertTopic', {
      topicName: 'hilom-enrollment-alerts',
    });
    alertTopic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail ?? DEFAULT_ALERT_EMAIL));

    new cloudwatch.Alarm(this, 'EnrollmentDlqAlarm', {
      alarmDescription: 'An order exhausted enrollment retries and needs manual admin retry.',
      metric: enrollmentRetryDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    const productsList = makeFn('ProductsListFn', 'handlers/products.ts', 'list');
    const productsDetail = makeFn('ProductsDetailFn', 'handlers/products.ts', 'detail');
    const coursesList = makeFn('CoursesListFn', 'handlers/courses.ts', 'list');
    const syncCourses = makeFn('SyncCoursesFn', 'handlers/admin.ts', 'syncCourses');
    const retryEnrollment = makeFn('RetryEnrollmentFn', 'handlers/admin.ts', 'retryEnrollment');
    const revokeAccess = makeFn('RevokeAccessFn', 'handlers/admin.ts', 'revokeAccess');
    const paymongoWebhook = makeFn('PayMongoWebhookFn', 'handlers/paymongo-webhook.ts', 'handler');
    const checkoutIntent = makeFn('CheckoutIntentFn', 'handlers/checkout.ts', 'createIntent');
    const orderStatus = makeFn('OrderStatusFn', 'handlers/orders.ts', 'status');
    const orderStatusByIntent = makeFn('OrderStatusByIntentFn', 'handlers/orders.ts', 'statusByIntent');
    const adminOrders = makeFn('AdminOrdersFn', 'handlers/orders.ts', 'adminList');
    const adminProductsList = makeFn('AdminProductsListFn', 'handlers/admin-products.ts', 'list');
    const adminProductsUpdate = makeFn('AdminProductsUpdateFn', 'handlers/admin-products.ts', 'update');
    const enrollmentRetryConsumer = makeFn(
      'EnrollmentRetryConsumerFn',
      'handlers/enrollment-retry-consumer.ts',
      'handler',
    );

    paymongoWebhook.addEnvironment('ENROLLMENT_RETRY_QUEUE_URL', enrollmentRetryQueue.queueUrl);
    enrollmentRetryQueue.grantSendMessages(paymongoWebhook);
    enrollmentRetryConsumer.addEventSource(
      new SqsEventSource(enrollmentRetryQueue, {
        batchSize: 5,
        reportBatchItemFailures: true, // only failed messages re-queue, not the whole batch
      }),
    );

    // Least privilege: only the functions that read a given secret can read it.
    for (const fn of [productsList, productsDetail, coursesList, syncCourses, retryEnrollment, checkoutIntent, orderStatus, orderStatusByIntent, adminOrders, revokeAccess, adminProductsList, adminProductsUpdate]) {
      supabaseSecret.grantRead(fn);
    }
    moodleSecret.grantRead(syncCourses);
    // Revoke unenrols via the Moodle web service, but needs no Cognito access:
    // the buyer's identity is deliberately left intact on refund.
    moodleSecret.grantRead(revokeAccess);
    adminKeySecret.grantRead(revokeAccess);
    paymongoSecret.grantRead(paymongoWebhook);
    paymongoSecret.grantRead(checkoutIntent);
    paymongoSecret.grantRead(orderStatusByIntent);
    adminKeySecret.grantRead(syncCourses);
    adminKeySecret.grantRead(retryEnrollment);
    adminKeySecret.grantRead(adminOrders);
    adminKeySecret.grantRead(adminProductsList);
    adminKeySecret.grantRead(adminProductsUpdate);

    // Every path that can fulfill an order needs the full fulfillment
    // dependency set: Supabase (orders), Moodle (enrollment), Cognito (buyer
    // identity).
    for (const fn of [paymongoWebhook, retryEnrollment, enrollmentRetryConsumer]) {
      supabaseSecret.grantRead(fn);
      moodleSecret.grantRead(fn);
      cognitoSecret.grantRead(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser'],
          resources: [cognitoUserPoolArn],
        }),
      );
    }

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
        // PATCH is needed by /admin/products/{id}. Without it the browser
        // preflight succeeds but omits PATCH from allow-methods, and the real
        // request fails as an opaque "Failed to fetch" with no server-side log.
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.OPTIONS,
        ],
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
    route('/admin/revoke-access/{orderId}', apigw.HttpMethod.POST, revokeAccess, 'RevokeAccessInt');
    route('/webhooks/paymongo', apigw.HttpMethod.POST, paymongoWebhook, 'PayMongoWebhookInt');
    route('/checkout/create-intent', apigw.HttpMethod.POST, checkoutIntent, 'CheckoutIntentInt');
    route('/orders/status/{paymentId}', apigw.HttpMethod.GET, orderStatus, 'OrderStatusInt');
    route('/orders/status-by-intent/{intentId}', apigw.HttpMethod.GET, orderStatusByIntent, 'OrderStatusByIntentInt');
    route('/admin/orders', apigw.HttpMethod.GET, adminOrders, 'AdminOrdersInt');
    route('/admin/products', apigw.HttpMethod.GET, adminProductsList, 'AdminProductsListInt');
    route('/admin/products/{productId}', apigw.HttpMethod.PATCH, adminProductsUpdate, 'AdminProductsUpdateInt');

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

    new cdk.CfnOutput(this, 'EnrollmentRetryQueueUrl', { value: enrollmentRetryQueue.queueUrl });
    new cdk.CfnOutput(this, 'EnrollmentRetryDlqUrl', { value: enrollmentRetryDlq.queueUrl });
  }
}
