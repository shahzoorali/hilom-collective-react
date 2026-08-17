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
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
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

    // Public read-only mirror of Moodle course images: pluginfile.php requires
    // the Moodle WS token to load, which must never reach the browser, so
    // syncCourses downloads each image server-side and re-hosts it here.
    const courseImagesBucket = new s3.Bucket(this, 'CourseImagesBucket', {
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CMS media. Separate from courseImagesBucket above, which is a public
    // read-only mirror of Moodle images written only by syncCourses; this one
    // takes browser uploads and is private, read through CloudFront only.
    //
    // Browser uploads go straight to S3 with a presigned PUT, so the bucket
    // needs its own CORS block — that is a different setting from the HTTP
    // API's corsPreflight further down, and editing the wrong one is the
    // obvious way to spend an afternoon on a broken upload.
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The site's images are content, not derived artifacts: tearing down the
      // stack must not delete them.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [props.corsOrigin ?? '*'],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // An upload whose presigned PUT succeeded but whose confirm call never
          // ran leaves an orphan object; this stops paying to store it forever.
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    const mediaDistribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      comment: 'Hilom CMS media',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // nosniff matters here: uploads are user-supplied files served from a
        // domain we control.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    });

    const productsList = makeFn('ProductsListFn', 'handlers/products.ts', 'list');
    const productsDetail = makeFn('ProductsDetailFn', 'handlers/products.ts', 'detail');
    const coursesList = makeFn('CoursesListFn', 'handlers/courses.ts', 'list');
    const syncCourses = makeFn('SyncCoursesFn', 'handlers/admin.ts', 'syncCourses');
    const retryEnrollment = makeFn('RetryEnrollmentFn', 'handlers/admin.ts', 'retryEnrollment');
    const revokeAccess = makeFn('RevokeAccessFn', 'handlers/admin.ts', 'revokeAccess');
    const paymongoWebhook = makeFn('PayMongoWebhookFn', 'handlers/paymongo-webhook.ts', 'handler');
    const checkoutSession = makeFn('CheckoutSessionFn', 'handlers/checkout.ts', 'createSession');
    const orderStatus = makeFn('OrderStatusFn', 'handlers/orders.ts', 'status');
    const orderStatusByIntent = makeFn('OrderStatusByIntentFn', 'handlers/orders.ts', 'statusByIntent');
    const orderStatusBySession = makeFn('OrderStatusBySessionFn', 'handlers/orders.ts', 'statusBySession');

    // Only QRPh is activated on the PayMongo account today. Adding GCash or
    // card later is a config change here, not a code change — but every value
    // must actually be activated, or session creation 400s.
    checkoutSession.addEnvironment(
      'CHECKOUT_PAYMENT_METHODS',
      props.checkoutPaymentMethods ?? 'qrph',
    );
    checkoutSession.addEnvironment(
      'FRONTEND_URL',
      props.frontendUrl ?? 'https://www.hilomcollective.com',
    );
    const adminOrders = makeFn('AdminOrdersFn', 'handlers/orders.ts', 'adminList');
    const adminOrderPayment = makeFn('AdminOrderPaymentFn', 'handlers/orders.ts', 'adminPayment');
    const adminProductsList = makeFn('AdminProductsListFn', 'handlers/admin-products.ts', 'list');
    const adminProductsUpdate = makeFn('AdminProductsUpdateFn', 'handlers/admin-products.ts', 'update');
    const enrollmentRetryConsumer = makeFn(
      'EnrollmentRetryConsumerFn',
      'handlers/enrollment-retry-consumer.ts',
      'handler',
    );
    const communitySubmit = makeFn('CommunitySubmitFn', 'handlers/community.ts', 'submit');

    // CMS. Unlike the commerce endpoints above, each of these files exports a
    // single `handler` that dispatches on the request path — see the note in
    // backend/src/handlers/pages.ts.
    const pagesPublic = makeFn('PagesPublicFn', 'handlers/pages.ts', 'handler');
    const menusPublic = makeFn('MenusPublicFn', 'handlers/menus.ts', 'handler');
    const formsPublic = makeFn('FormsPublicFn', 'handlers/forms.ts', 'handler');
    const adminPages = makeFn('AdminPagesFn', 'handlers/admin-pages.ts', 'handler');
    const adminMenus = makeFn('AdminMenusFn', 'handlers/admin-menus.ts', 'handler');
    const adminMedia = makeFn('AdminMediaFn', 'handlers/admin-media.ts', 'handler');
    const adminForms = makeFn('AdminFormsFn', 'handlers/admin-forms.ts', 'handler');
    const eventsPublic = makeFn('EventsPublicFn', 'handlers/events.ts', 'handler');
    const adminEvents = makeFn('AdminEventsFn', 'handlers/admin-events.ts', 'handler');
    const postsPublic = makeFn('PostsPublicFn', 'handlers/posts.ts', 'handler');
    const adminPosts = makeFn('AdminPostsFn', 'handlers/admin-posts.ts', 'handler');
    // Not behind API Gateway — invoked on a schedule (below), not by a
    // request. Publishes posts/pages whose scheduled_at has arrived.
    const scheduledPublishSweep = makeFn(
      'ScheduledPublishSweepFn',
      'handlers/scheduled-publish-sweep.ts',
      'handler',
    );

    // SES sends from ap-south-1 (Mumbai), not this stack's ap-southeast-1:
    // hilomcollective.com is already a verified, DKIM-signed domain identity
    // there with production access, so no new identity/DNS work was needed.
    communitySubmit.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          `arn:aws:ses:ap-south-1:${this.account}:identity/hilomcollective.com`,
          // The domain identity has a default configuration set attached, so SES
          // checks permission on that resource too, not just the identity.
          `arn:aws:ses:ap-south-1:${this.account}:configuration-set/default-config-set`,
        ],
      }),
    );

    paymongoWebhook.addEnvironment('ENROLLMENT_RETRY_QUEUE_URL', enrollmentRetryQueue.queueUrl);
    enrollmentRetryQueue.grantSendMessages(paymongoWebhook);
    enrollmentRetryConsumer.addEventSource(
      new SqsEventSource(enrollmentRetryQueue, {
        batchSize: 5,
        reportBatchItemFailures: true, // only failed messages re-queue, not the whole batch
      }),
    );

    // Scheduled publish: a rate rule, not `cron`, because "publish within a
    // few minutes of the scheduled time" is the actual requirement — cron's
    // wall-clock-aligned firing buys nothing here and is harder to reason
    // about the latency of.
    new events.Rule(this, 'ScheduledPublishRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(scheduledPublishSweep)],
    });

    // Least privilege: only the functions that read a given secret can read it.
    for (const fn of [productsList, productsDetail, coursesList, syncCourses, retryEnrollment, checkoutSession, orderStatus, orderStatusByIntent, orderStatusBySession, adminOrders, adminOrderPayment, revokeAccess, adminProductsList, adminProductsUpdate]) {
      supabaseSecret.grantRead(fn);
    }
    moodleSecret.grantRead(syncCourses);
    courseImagesBucket.grantPut(syncCourses);
    syncCourses.addEnvironment('COURSE_IMAGES_BUCKET', courseImagesBucket.bucketName);
    syncCourses.addEnvironment('COURSE_IMAGES_BUCKET_URL', `https://${courseImagesBucket.bucketName}.s3.${this.region}.amazonaws.com`);
    // Revoke unenrols via the Moodle web service, but needs no Cognito access:
    // the buyer's identity is deliberately left intact on refund.
    moodleSecret.grantRead(revokeAccess);
    adminKeySecret.grantRead(revokeAccess);
    paymongoSecret.grantRead(paymongoWebhook);
    paymongoSecret.grantRead(checkoutSession);
    paymongoSecret.grantRead(orderStatusByIntent);
    paymongoSecret.grantRead(orderStatusBySession);
    adminKeySecret.grantRead(syncCourses);
    adminKeySecret.grantRead(retryEnrollment);
    adminKeySecret.grantRead(adminOrders);
    // Reads the transaction behind an order straight from PayMongo, so it needs
    // both the admin key (to authorize the caller) and the PayMongo secret key.
    adminKeySecret.grantRead(adminOrderPayment);
    paymongoSecret.grantRead(adminOrderPayment);
    adminKeySecret.grantRead(adminProductsList);
    adminKeySecret.grantRead(adminProductsUpdate);

    // CMS grants.
    for (const fn of [
      pagesPublic, menusPublic, formsPublic, adminPages, adminMenus, adminMedia, adminForms,
      eventsPublic, adminEvents, postsPublic, adminPosts, scheduledPublishSweep,
    ]) {
      supabaseSecret.grantRead(fn);
    }
    for (const fn of [adminPages, adminMenus, adminMedia, adminForms, adminEvents, adminPosts]) {
      adminKeySecret.grantRead(fn);
    }
    // The public form endpoint salts its IP hashes with the admin key, which is
    // the one high-entropy secret this function already has a reason to reach.
    adminKeySecret.grantRead(formsPublic);

    // Presigning can only sign what the signing role is itself allowed to do,
    // so these grants are what make the upload URL work — and what bound it.
    mediaBucket.grantPut(adminMedia);
    mediaBucket.grantRead(adminMedia); // HeadObject on confirm
    mediaBucket.grantDelete(adminMedia);
    adminMedia.addEnvironment('MEDIA_BUCKET', mediaBucket.bucketName);
    adminMedia.addEnvironment('MEDIA_CDN_BASE', `https://${mediaDistribution.distributionDomainName}`);

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
        // PUT and DELETE were added for the CMS: draft/menu/form saves are PUT,
        // and page/media/submission removal is DELETE. Same failure mode as
        // PATCH if they are missing.
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
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
    route('/checkout/create-session', apigw.HttpMethod.POST, checkoutSession, 'CheckoutSessionInt');
    route('/orders/status/{paymentId}', apigw.HttpMethod.GET, orderStatus, 'OrderStatusInt');
    route('/orders/status-by-intent/{intentId}', apigw.HttpMethod.GET, orderStatusByIntent, 'OrderStatusByIntentInt');
    route('/orders/status-by-session/{sessionId}', apigw.HttpMethod.GET, orderStatusBySession, 'OrderStatusBySessionInt');
    route('/admin/orders', apigw.HttpMethod.GET, adminOrders, 'AdminOrdersInt');
    route('/admin/orders/{orderId}/payment', apigw.HttpMethod.GET, adminOrderPayment, 'AdminOrderPaymentInt');
    route('/admin/products', apigw.HttpMethod.GET, adminProductsList, 'AdminProductsListInt');
    route('/admin/products/{productId}', apigw.HttpMethod.PATCH, adminProductsUpdate, 'AdminProductsUpdateInt');
    route('/community/submit', apigw.HttpMethod.POST, communitySubmit, 'CommunitySubmitInt');

    // -----------------------------------------------------------------
    // CMS routes. One integration per function, reused across that
    // function's routes — `route` above creates a new integration per call,
    // which is fine for one route each but needless when one Lambda backs a
    // dozen.
    // -----------------------------------------------------------------
    const cmsRoutes = (
      fn: nodejs.NodejsFunction,
      id: string,
      entries: [string, apigw.HttpMethod[]][],
    ): void => {
      const integration = new integrations.HttpLambdaIntegration(id, fn);
      for (const [routePath, methods] of entries) {
        httpApi.addRoutes({ path: routePath, methods, integration });
      }
    };

    const { GET, POST, PUT, PATCH, DELETE } = apigw.HttpMethod;

    cmsRoutes(pagesPublic, 'PagesPublicInt', [
      ['/pages', [GET]],
      ['/pages/{slug}', [GET]],
    ]);
    cmsRoutes(menusPublic, 'MenusPublicInt', [['/menus', [GET]]]);
    cmsRoutes(formsPublic, 'FormsPublicInt', [
      ['/forms/{slug}', [GET]],
      ['/forms/{slug}/submissions', [POST]],
    ]);
    cmsRoutes(adminPages, 'AdminPagesInt', [
      ['/admin/pages', [GET, POST]],
      // Static route registered ahead of the {pageId} entries below — API
      // Gateway prefers an exact match, so a literal "trash" segment never
      // gets captured as a page id.
      ['/admin/pages/trash', [GET]],
      ['/admin/pages/{pageId}', [GET, PATCH, DELETE]],
      ['/admin/pages/{pageId}/draft', [PUT]],
      ['/admin/pages/{pageId}/publish', [POST]],
      ['/admin/pages/{pageId}/unpublish', [POST]],
      ['/admin/pages/{pageId}/untrash', [POST]],
      ['/admin/pages/{pageId}/duplicate', [POST]],
      ['/admin/pages/{pageId}/permanent', [DELETE]],
      ['/admin/pages/{pageId}/revisions', [GET]],
      ['/admin/pages/{pageId}/revisions/{revisionId}/restore', [POST]],
    ]);
    cmsRoutes(adminMenus, 'AdminMenusInt', [
      ['/admin/menus', [GET]],
      ['/admin/menus/{key}', [PUT]],
    ]);
    cmsRoutes(adminMedia, 'AdminMediaInt', [
      ['/admin/media', [GET, POST]],
      ['/admin/media/upload-url', [POST]],
      ['/admin/media/{mediaId}', [PATCH, DELETE]],
    ]);
    cmsRoutes(adminForms, 'AdminFormsInt', [
      ['/admin/forms', [GET, POST]],
      ['/admin/forms/{formId}', [GET, PUT, DELETE]],
      ['/admin/forms/{formId}/submissions', [GET]],
      ['/admin/forms/{formId}/submissions/{submissionId}', [DELETE]],
    ]);
    cmsRoutes(eventsPublic, 'EventsPublicInt', [['/events', [GET]]]);
    cmsRoutes(adminEvents, 'AdminEventsInt', [
      ['/admin/events', [GET, POST]],
      ['/admin/events/{eventId}', [GET, PUT, DELETE]],
    ]);
    cmsRoutes(postsPublic, 'PostsPublicInt', [
      ['/posts', [GET]],
      ['/posts/{slug}', [GET]],
      ['/categories', [GET]],
    ]);
    cmsRoutes(adminPosts, 'AdminPostsInt', [
      ['/admin/posts', [GET, POST]],
      // Static route ahead of {postId} — same reasoning as pages/trash above.
      ['/admin/posts/trash', [GET]],
      ['/admin/posts/{postId}', [GET, PATCH, DELETE]],
      ['/admin/posts/{postId}/draft', [PUT]],
      ['/admin/posts/{postId}/publish', [POST]],
      ['/admin/posts/{postId}/unpublish', [POST]],
      ['/admin/posts/{postId}/untrash', [POST]],
      ['/admin/posts/{postId}/duplicate', [POST]],
      ['/admin/posts/{postId}/permanent', [DELETE]],
      ['/admin/posts/{postId}/revisions', [GET]],
      ['/admin/posts/{postId}/revisions/{revisionId}/restore', [POST]],
      ['/admin/categories', [GET, POST]],
      ['/admin/categories/{categoryId}', [PATCH, DELETE]],
    ]);

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

    new cdk.CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new cdk.CfnOutput(this, 'MediaCdnDomain', {
      value: `https://${mediaDistribution.distributionDomainName}`,
      description: 'Base URL stored on every media_assets row',
    });

    new cdk.CfnOutput(this, 'EnrollmentRetryQueueUrl', { value: enrollmentRetryQueue.queueUrl });
    new cdk.CfnOutput(this, 'EnrollmentRetryDlqUrl', { value: enrollmentRetryDlq.queueUrl });
    new cdk.CfnOutput(this, 'CourseImagesBucketName', { value: courseImagesBucket.bucketName });
  }
}
