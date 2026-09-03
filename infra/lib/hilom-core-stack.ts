/**
 * Hilom core — the storefront, the money, and everything stateful.
 *
 * **This stack is still deployed under the name `HilomBackendStack`.** It was
 * the single stack before the split, and a CloudFormation stack cannot be
 * renamed: a new name is a new stack, which would create a second copy of
 * everything here and orphan the originals. `bin/infra.ts` therefore
 * instantiates this class with the construct id `HilomBackendStack`, and the
 * class name is the only thing that changed. Do not "tidy" that up.
 *
 * **What lives here is not an arbitrary grouping.** Everything whose identity
 * cannot be recreated stayed in this stack, with its construct id untouched,
 * so the split never asked CloudFormation to replace it:
 *
 *   - the media and course-image buckets, whose names are generated from the
 *     stack and are stored in `media_assets` rows,
 *   - the CloudFront distribution, whose domain is likewise in the database,
 *   - the generated admin API key, which exists nowhere else,
 *   - the Cognito groups, which carry facilitator and admin membership,
 *   - the enrollment retry queue and its DLQ, which can hold real messages,
 *   - the HTTP API, its custom domain and its stage — the thing the other two
 *     stacks hang their routes on.
 *
 * The commerce Lambdas stayed too, because the public storefront —
 * `/products`, `/checkout`, `/webhooks/paymongo`, `/orders/*` — is the part
 * that must not go down during a deploy of anything else.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import {
  DEFAULT_ALERT_EMAIL,
  DEFAULT_CHECKOUT_PAYMENT_METHODS,
  DEFAULT_COGNITO_SPA_CLIENT_ID,
  DEFAULT_COGNITO_USER_POOL_ID,
  DEFAULT_FRONTEND_URL,
  DEFAULT_PARTICIPANT_AGREEMENT_EVENT_IDS,
  lambdaFactory,
  sesSendPolicy,
  type HilomCommonProps,
} from './hilom-shared';

export interface HilomCoreStackProps extends HilomCommonProps {
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
}

export class HilomCoreStack extends cdk.Stack {
  /** The one HTTP API. The CMS and marketplace stacks attach routes to it. */
  public readonly httpApi: apigw.HttpApi;
  /** CMS media. Written by the CMS stack's media function, which lives there. */
  public readonly mediaBucket: s3.Bucket;
  public readonly mediaDistribution: cloudfront.Distribution;
  /**
   * Encrypts facilitator OAuth tokens for Google Meet and Zoom. Lives in the
   * core stack rather than the marketplace one because two stacks now hold
   * functions that decrypt with it — the marketplace's booking/portal/admin
   * handlers, and this stack's PayMongo webhook (which confirms a paid booking
   * and, for an integrated service, creates the meeting). A key in the
   * marketplace stack would make core depend on marketplace, and marketplace
   * already depends on core for the HTTP API — a cycle CDK rejects.
   */
  public readonly integrationTokenKey: kms.Key;

  constructor(scope: Construct, id: string, props: HilomCoreStackProps = {}) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Secrets. These are created outside CDK (they hold real credentials that
    // must not live in a template), so they are imported by name.
    // ---------------------------------------------------------------------
    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(this, 'SupabaseSecret', 'hilom/supabase');
    const moodleSecret = secretsmanager.Secret.fromSecretNameV2(this, 'MoodleSecret', 'hilom/moodle');
    const paymongoSecretId = props.paymongoSecretId ?? 'hilom/paymongo/test';
    const paymongoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'PayMongoSecret', paymongoSecretId);
    const cognitoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'CognitoSecret', 'hilom/cognito');
    const recaptchaSecret = secretsmanager.Secret.fromSecretNameV2(this, 'RecaptchaSecret', 'hilom/recaptcha');

    const cognitoUserPoolId = props.cognitoUserPoolId ?? DEFAULT_COGNITO_USER_POOL_ID;
    const cognitoSpaClientId = props.cognitoSpaClientId ?? DEFAULT_COGNITO_SPA_CLIENT_ID;
    const cognitoUserPoolArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${cognitoUserPoolId}`;

    // ---------------------------------------------------------------------
    // Roles.
    //
    // The user pool itself is not managed by this stack (it predates it and is
    // imported by id), but groups are additive and safe to declare here: a
    // CfnUserPoolGroup creates only the group, and removing it removes only the
    // group, never the pool or its users.
    //
    // Groups rather than a `role` column because the check has to happen on
    // every request anyway, and Cognito already signs the claim — a database
    // role would mean a lookup per call and a second source of truth to keep in
    // sync with the token. `backend/src/lib/auth.ts` reads `cognito:groups`
    // straight off the verified id token.
    //
    // Membership is assigned out-of-band (admin approving a facilitator calls
    // AdminAddUserToGroup); nothing here grants anyone anything. It is also why
    // these two stayed in this stack through the split: deleting a group to
    // recreate it elsewhere would silently empty it.
    // ---------------------------------------------------------------------
    new cognito.CfnUserPoolGroup(this, 'FacilitatorGroup', {
      userPoolId: cognitoUserPoolId,
      groupName: 'facilitator',
      description: 'Approved facilitators — access to the facilitator dashboard',
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: cognitoUserPoolId,
      groupName: 'admin',
      description: 'Hilom staff — access to /admin without the shared key',
    });

    // The admin key has no external source of truth, so CDK generates it. It is
    // never rendered into the template — only the generated secret's ARN is.
    // The other two stacks read it by name (ADMIN_KEY_SECRET_NAME), never by
    // recreating this construct: a second `new Secret` on the same name is a
    // name collision, and losing this one means losing the only copy of the key.
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
    const makeFn = lambdaFactory(this, {
      corsOrigin: props.corsOrigin ?? '*',
      adminKeySecretName: adminKeySecret.secretName,
    });

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
    //
    // Written by the CMS stack's media function, not by anything here. It
    // stays in this stack anyway: the bucket name is generated from the stack
    // and the CloudFront domain below is stored on every media_assets row, so
    // moving either would break every image on the site.
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
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

    this.mediaDistribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      comment: 'Hilom CMS media',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // nosniff matters here: uploads are user-supplied files served from a
        // domain we control.
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
    });

    // No alias. The application references this key only by ARN (via the
    // INTEGRATION_TOKEN_KEY_ID env var), and giving it the alias the previous
    // marketplace-stack key held would collide during the migration deploy.
    this.integrationTokenKey = new kms.Key(this, 'IntegrationTokenKey', {
      description: 'Encrypts facilitator OAuth tokens for Google Meet and Zoom',
      enableKeyRotation: true,
      // Destroying it makes every stored token permanently undecryptable and
      // silently breaks every connected account.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
    const meOwnedCourses = makeFn('MeOwnedCoursesFn', 'handlers/me.ts', 'ownedCourses');
    // Same reasoning as checkoutSession below: verifies the buyer's id_token,
    // so it needs the same (non-secret) pool/client ids.
    meOwnedCourses.addEnvironment('COGNITO_USER_POOL_ID', cognitoUserPoolId);
    meOwnedCourses.addEnvironment('COGNITO_SPA_CLIENT_ID', cognitoSpaClientId);

    // Only QRPh is activated on the PayMongo account today. Adding GCash or
    // card later is a config change here, not a code change — but every value
    // must actually be activated, or session creation 400s.
    checkoutSession.addEnvironment(
      'CHECKOUT_PAYMENT_METHODS',
      props.checkoutPaymentMethods ?? DEFAULT_CHECKOUT_PAYMENT_METHODS,
    );
    checkoutSession.addEnvironment(
      'FRONTEND_URL',
      props.frontendUrl ?? DEFAULT_FRONTEND_URL,
    );
    // Checkout verifies the buyer's Cognito id_token so `buyer_email` comes from
    // a signed claim rather than the request body. Neither value is secret —
    // both already ship inside the public frontend bundle — so they are plain
    // env vars, not a Secrets Manager fetch on every checkout.
    checkoutSession.addEnvironment('COGNITO_USER_POOL_ID', cognitoUserPoolId);
    checkoutSession.addEnvironment('COGNITO_SPA_CLIENT_ID', cognitoSpaClientId);
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

    // The CMS form endpoint has the same SES need and is granted the same
    // statement in the CMS stack — see the note there.
    communitySubmit.addToRolePolicy(sesSendPolicy(this));

    // ---------------------------------------------------------------------
    // Cognito CustomEmailSender.
    //
    // Every Cognito-originated email (sign-up code, resend, forgotten
    // password, attribute verification) is sent by this Lambda through the
    // ap-south-1 SES identity instead of by Cognito itself. The user pool
    // only accepts an SES SourceArn in eu-west-1 / ap-southeast-1 / us-east-1
    // / us-west-2, and the sole region with SES production access here is
    // ap-south-1 — not on that list. CustomEmailSender has no such
    // restriction: Cognito hands the code to the function and it sends
    // however it likes.
    //
    // The pool predates these stacks and is imported by id, so the trigger
    // itself (LambdaConfig.CustomEmailSender + KMSKeyID) is wired on the pool
    // out of band with `aws cognito-idp update-user-pool`, not here. This
    // stack owns only the key and the function.
    //
    // Cognito encrypts the code to this key with the AWS Encryption SDK; the
    // handler decrypts with @aws-crypto/client-node. Cognito needs
    // encrypt + CreateGrant (it grants the decrypt down to itself at send
    // time); the function needs decrypt.
    const cognitoEmailKey = new kms.Key(this, 'CognitoCustomEmailKey', {
      alias: 'alias/hilom-cognito-custom-email',
      description: 'Encrypts Cognito CustomEmailSender codes; decrypted by CognitoCustomEmailFn',
      enableKeyRotation: true,
    });
    cognitoEmailKey.grant(
      new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      'kms:Encrypt',
      'kms:Decrypt',
      'kms:CreateGrant',
    );

    const cognitoCustomEmail = makeFn(
      'CognitoCustomEmailFn',
      'handlers/cognito-custom-email.ts',
      'handler',
    );
    cognitoCustomEmail.addEnvironment('COGNITO_CUSTOM_EMAIL_KEY_ARN', cognitoEmailKey.keyArn);
    cognitoEmailKey.grantDecrypt(cognitoCustomEmail);
    cognitoCustomEmail.addToRolePolicy(sesSendPolicy(this));
    // Let the pool invoke it. Scoped to this one pool's ARN so a second pool
    // in the account cannot trigger it.
    cognitoCustomEmail.addPermission('CognitoCustomEmailInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: cognitoUserPoolArn,
    });

    // Same SES identity, granted to every path that can call fulfillOrder and
    // so may send either of the two emails it can trigger: the account-created
    // welcome email (backend/src/lib/email.ts, via ensureCognitoUser) and the
    // enrollment-confirmation email (backend/src/lib/enrollment-email.ts) —
    // both plain SES API calls, so neither is tied to this Lambda's own region.
    //
    // These two also reach applyChargePayment now (a paid event registration
    // arrives through the same webhook and the same retry queue), which sends
    // registration confirmations and receipts through this identity as well.
    for (const fn of [paymongoWebhook, retryEnrollment, enrollmentRetryConsumer]) {
      fn.addToRolePolicy(sesSendPolicy(this));
    }

    // Which events' confirmation email attaches the participant agreement PDF.
    // Read by backend/src/lib/participant-agreement.ts; the bytes ride in the
    // bundle via the esbuild binary loader, this only gates them. Just the two
    // paths here that reach applyChargePayment — retryEnrollment is course
    // orders, not registration charges. The admin offline-payment path is in
    // the marketplace stack and is gated there.
    for (const fn of [paymongoWebhook, enrollmentRetryConsumer]) {
      fn.addEnvironment(
        'PARTICIPANT_AGREEMENT_EVENT_IDS',
        props.participantAgreementEventIds ?? DEFAULT_PARTICIPANT_AGREEMENT_EVENT_IDS,
      );
    }

    paymongoWebhook.addEnvironment('ENROLLMENT_RETRY_QUEUE_URL', enrollmentRetryQueue.queueUrl);
    enrollmentRetryQueue.grantSendMessages(paymongoWebhook);
    enrollmentRetryConsumer.addEventSource(
      new SqsEventSource(enrollmentRetryQueue, {
        batchSize: 5,
        reportBatchItemFailures: true, // only failed messages re-queue, not the whole batch
      }),
    );

    // Least privilege: only the functions that read a given secret can read it.
    for (const fn of [productsList, productsDetail, coursesList, syncCourses, retryEnrollment, checkoutSession, orderStatus, orderStatusByIntent, orderStatusBySession, adminOrders, adminOrderPayment, revokeAccess, adminProductsList, adminProductsUpdate, meOwnedCourses]) {
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
    // Grant + env var both point at paymongoSecretId together: the grant alone
    // controls nothing at runtime — see the prop's doc comment for the bug this
    // closes (PAYMONGO_SECRET_ID was never actually set anywhere).
    for (const fn of [paymongoWebhook, checkoutSession, orderStatusByIntent, orderStatusBySession, adminOrderPayment]) {
      paymongoSecret.grantRead(fn);
      fn.addEnvironment('PAYMONGO_SECRET_ID', paymongoSecretId);
    }
    adminKeySecret.grantRead(syncCourses);
    adminKeySecret.grantRead(retryEnrollment);
    adminKeySecret.grantRead(adminOrders);
    // Reads the transaction behind an order straight from PayMongo, so it needs
    // both the admin key (to authorize the caller) and the PayMongo secret key.
    adminKeySecret.grantRead(adminOrderPayment);
    adminKeySecret.grantRead(adminProductsList);
    adminKeySecret.grantRead(adminProductsUpdate);

    // reCAPTCHA verification for the one public submission path that lives in
    // this stack. The CMS stack's form endpoint has the same grant.
    recaptchaSecret.grantRead(communitySubmit);

    // Every path that can fulfill an order needs the full fulfillment
    // dependency set: Supabase (orders, and now registration charges), Moodle
    // (enrollment), Cognito (buyer identity). SES is granted separately above — the same ap-south-1 grant
    // already covers both the account-created welcome email and the
    // enrollment-confirmation email (enrollment-email.ts), since both are
    // plain SES API calls with no region tie to the function's own region.
    // The webhook confirms a paid booking, and for a service set to Google
    // Meet or Zoom that means decrypting the facilitator's token and creating
    // a meeting. Read on both OAuth secrets, decrypt on the token key.
    const googleMeetSecret = secretsmanager.Secret.fromSecretNameV2(this, 'GoogleMeetSecret', 'hilom/google-meet');
    const zoomSecret = secretsmanager.Secret.fromSecretNameV2(this, 'ZoomSecret', 'hilom/zoom');
    googleMeetSecret.grantRead(paymongoWebhook);
    zoomSecret.grantRead(paymongoWebhook);
    this.integrationTokenKey.grantDecrypt(paymongoWebhook);
    paymongoWebhook.addEnvironment('INTEGRATION_TOKEN_KEY_ID', this.integrationTokenKey.keyArn);

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
    //
    // One API for all three stacks. A second API would need its own custom
    // domain or a path prefix like /cms, and every URL the frontend already
    // ships would have to change — so the CMS and marketplace stacks import
    // this one's id and attach their routes to it instead.
    // ---------------------------------------------------------------------
    let domainName: apigw.DomainName | undefined;
    if (props.apiCertificateArn) {
      domainName = new apigw.DomainName(this, 'ApiDomain', {
        domainName: 'api.hilomcollective.com',
        certificate: acm.Certificate.fromCertificateArn(this, 'ApiCert', props.apiCertificateArn),
      });
    }

    this.httpApi = new apigw.HttpApi(this, 'HilomHttpApi', {
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
        //
        // CORS is configured on the API, so it covers the routes the other two
        // stacks add as well — a new method used only by the CMS still has to
        // be listed here.
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.PUT,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        // x-admin-actor carries the operator's name for the audit log. Omitting
        // it here does not degrade gracefully — the browser fails preflight and
        // every admin write surfaces as an opaque "Failed to fetch".
        allowHeaders: ['content-type', 'x-admin-key', 'authorization', 'x-admin-actor'],
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
      this.httpApi.addRoutes({
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
    route('/me/owned-courses', apigw.HttpMethod.GET, meOwnedCourses, 'MeOwnedCoursesInt');
    route('/admin/orders', apigw.HttpMethod.GET, adminOrders, 'AdminOrdersInt');
    route('/admin/orders/{orderId}/payment', apigw.HttpMethod.GET, adminOrderPayment, 'AdminOrderPaymentInt');
    route('/admin/products', apigw.HttpMethod.GET, adminProductsList, 'AdminProductsListInt');
    route('/admin/products/{productId}', apigw.HttpMethod.PATCH, adminProductsUpdate, 'AdminProductsUpdateInt');
    route('/community/submit', apigw.HttpMethod.POST, communitySubmit, 'CommunitySubmitInt');

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
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

    new cdk.CfnOutput(this, 'MediaBucketName', { value: this.mediaBucket.bucketName });
    new cdk.CfnOutput(this, 'MediaCdnDomain', {
      value: `https://${this.mediaDistribution.distributionDomainName}`,
      description: 'Base URL stored on every media_assets row',
    });

    new cdk.CfnOutput(this, 'EnrollmentRetryQueueUrl', { value: enrollmentRetryQueue.queueUrl });
    new cdk.CfnOutput(this, 'EnrollmentRetryDlqUrl', { value: enrollmentRetryDlq.queueUrl });
    new cdk.CfnOutput(this, 'CourseImagesBucketName', { value: courseImagesBucket.bucketName });
  }
}
