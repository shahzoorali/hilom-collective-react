/**
 * Hilom CMS — pages, posts, menus, media, forms, and the events *listing*.
 *
 * Split out of the single backend stack when it hit CloudFormation's 500
 * resource ceiling. Nothing about the runtime changed: these functions attach
 * their routes to the same HTTP API on the same custom domain, so every URL
 * the frontend calls is unchanged.
 *
 * **Where the events boundary falls.** `/events` and `/admin/events` live
 * here, because an event is a piece of content before it is a product. The
 * *ticketing* side — `/events/{id}/ticketing`, registration, rosters — lives
 * in the marketplace stack with bookings, because it is money and seats.
 * Both attach to the same API and HTTP APIs always prefer the more specific
 * match, so `/admin/events/{eventId}/roster` (marketplace) and
 * `/admin/events/{eventId}` (here) coexist without either stack knowing about
 * the other.
 *
 * **The media bucket is not here.** It and its CloudFront distribution stay in
 * the core stack: their generated names are stored in `media_assets` rows, so
 * recreating them under a new stack would break every image on the site. This
 * stack receives them as props and takes an IAM grant across the boundary.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import {
  ADMIN_KEY_SECRET_NAME,
  lambdaFactory,
  routeAttacher,
  sesSendPolicy,
  type HilomCommonProps,
} from './hilom-shared';

export interface HilomCmsStackProps extends HilomCommonProps {
  /** The core stack's HTTP API. Routes are attached to it, not to a new one. */
  readonly httpApiId: string;
  /** Core-owned; this stack only writes to it. */
  readonly mediaBucket: s3.IBucket;
  /** `https://dxxxx.cloudfront.net` — stored on every media_assets row. */
  readonly mediaCdnBase: string;
}

export class HilomCmsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HilomCmsStackProps) {
    super(scope, id, props);

    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(this, 'SupabaseSecret', 'hilom/supabase');
    const recaptchaSecret = secretsmanager.Secret.fromSecretNameV2(this, 'RecaptchaSecret', 'hilom/recaptcha');
    // Imported by name rather than passed from the core stack — see the note
    // on ADMIN_KEY_SECRET_NAME. `new Secret` here would collide on the name and
    //, worse, could destroy the only copy of the key.
    const adminKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'AdminApiKey',
      ADMIN_KEY_SECRET_NAME,
    );

    const makeFn = lambdaFactory(this, {
      corsOrigin: props.corsOrigin ?? '*',
      adminKeySecretName: ADMIN_KEY_SECRET_NAME,
    });

    // Each of these files exports a single `handler` that dispatches on the
    // request path — see the note in backend/src/handlers/pages.ts.
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

    // Not behind API Gateway — invoked on a schedule, not by a request.
    // Publishes posts/pages whose scheduled_at has arrived.
    const scheduledPublishSweep = makeFn(
      'ScheduledPublishSweepFn',
      'handlers/scheduled-publish-sweep.ts',
      'handler',
    );

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
    // reCAPTCHA verification: this is a public submission path, so it needs the
    // secret key to call Google's siteverify endpoint.
    recaptchaSecret.grantRead(formsPublic);
    // A CMS-built form notifies its configured notify_email the same way the
    // hardcoded community form (core stack) does — see notifySubmission in
    // backend/src/handlers/forms.ts.
    formsPublic.addToRolePolicy(sesSendPolicy(this));

    // Presigning can only sign what the signing role is itself allowed to do,
    // so these grants are what make the upload URL work — and what bound it.
    // The bucket is core-owned, so each of these renders as a cross-stack
    // import of its ARN.
    props.mediaBucket.grantPut(adminMedia);
    props.mediaBucket.grantRead(adminMedia); // HeadObject on confirm
    props.mediaBucket.grantDelete(adminMedia);
    adminMedia.addEnvironment('MEDIA_BUCKET', props.mediaBucket.bucketName);
    adminMedia.addEnvironment('MEDIA_CDN_BASE', props.mediaCdnBase);

    // Scheduled publish: a rate rule, not `cron`, because "publish within a
    // few minutes of the scheduled time" is the actual requirement — cron's
    // wall-clock-aligned firing buys nothing here and is harder to reason
    // about the latency of.
    new events.Rule(this, 'ScheduledPublishRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(scheduledPublishSweep)],
    });

    // -----------------------------------------------------------------
    // Routes on the core stack's API.
    // -----------------------------------------------------------------
    const httpApi = apigw.HttpApi.fromHttpApiAttributes(this, 'HilomHttpApi', {
      httpApiId: props.httpApiId,
    });
    const attach = routeAttacher(this, httpApi);
    const { GET, POST, PUT, PATCH, DELETE } = apigw.HttpMethod;

    attach(pagesPublic, 'PagesPublicInt', [
      ['/pages', [GET]],
      ['/pages/{slug}', [GET]],
    ]);
    attach(menusPublic, 'MenusPublicInt', [['/menus', [GET]]]);
    attach(formsPublic, 'FormsPublicInt', [
      ['/forms/{slug}', [GET]],
      ['/forms/{slug}/submissions', [POST]],
    ]);
    attach(adminPages, 'AdminPagesInt', [
      ['/admin/pages', [GET, POST]],
      // Literal ahead of {pageId} — a convention for readability; HTTP APIs
      // prefer the exact match regardless of declaration order.
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
    attach(adminMenus, 'AdminMenusInt', [
      ['/admin/menus', [GET]],
      ['/admin/menus/{key}', [PUT]],
    ]);
    attach(adminMedia, 'AdminMediaInt', [
      ['/admin/media', [GET, POST]],
      ['/admin/media/upload-url', [POST]],
      ['/admin/media/{mediaId}', [PATCH, DELETE]],
    ]);
    attach(adminForms, 'AdminFormsInt', [
      ['/admin/forms', [GET, POST]],
      ['/admin/forms/{formId}', [GET, PUT, DELETE]],
      ['/admin/forms/{formId}/submissions', [GET]],
      ['/admin/forms/{formId}/submissions/{submissionId}', [DELETE]],
    ]);
    attach(eventsPublic, 'EventsPublicInt', [['/events', [GET]]]);
    attach(adminEvents, 'AdminEventsInt', [
      ['/admin/events', [GET, POST]],
      ['/admin/events/{eventId}/plans', [GET, PUT]],
      ['/admin/events/{eventId}', [GET, PUT, DELETE]],
    ]);
    attach(postsPublic, 'PostsPublicInt', [
      ['/posts', [GET]],
      ['/posts/{slug}', [GET]],
      ['/categories', [GET]],
    ]);
    attach(adminPosts, 'AdminPostsInt', [
      ['/admin/posts', [GET, POST]],
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
  }
}
