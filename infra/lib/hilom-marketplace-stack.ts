/**
 * Hilom marketplace — facilitators, bookings, ticketed events, and the people
 * directory.
 *
 * Split out of the single backend stack when it hit CloudFormation's 500
 * resource ceiling. Routes attach to the core stack's HTTP API, so no URL
 * changed.
 *
 * **Functions are split by audience, not by resource.** Public directory, the
 * client's own bookings, the facilitator's dashboard, and admin each get their
 * own Lambda. That split is the authorization boundary — each function has
 * exactly one way of establishing who is calling — so a route wired to the
 * wrong function fails closed rather than leaking a calendar.
 *
 * **The two sweeps are scheduled, not routed.** Nothing calls them over HTTP;
 * their EventBridge rules live here with them.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import {
  ADMIN_KEY_SECRET_NAME,
  DEFAULT_ALERT_EMAIL,
  DEFAULT_CHECKOUT_PAYMENT_METHODS,
  DEFAULT_COGNITO_SPA_CLIENT_ID,
  DEFAULT_COGNITO_USER_POOL_ID,
  DEFAULT_FRONTEND_URL,
  lambdaFactory,
  routeAttacher,
  sesSendPolicy,
  type HilomCommonProps,
} from './hilom-shared';

export interface HilomMarketplaceStackProps extends HilomCommonProps {
  /** The core stack's HTTP API. Routes are attached to it, not to a new one. */
  readonly httpApiId: string;
}

export class HilomMarketplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HilomMarketplaceStackProps) {
    super(scope, id, props);

    const supabaseSecret = secretsmanager.Secret.fromSecretNameV2(this, 'SupabaseSecret', 'hilom/supabase');
    const cognitoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'CognitoSecret', 'hilom/cognito');
    const paymongoSecretId = props.paymongoSecretId ?? 'hilom/paymongo/test';
    const paymongoSecret = secretsmanager.Secret.fromSecretNameV2(this, 'PayMongoSecret', paymongoSecretId);
    // Imported by name, never created here — the core stack owns the only copy.
    const adminKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'AdminApiKey',
      ADMIN_KEY_SECRET_NAME,
    );

    const cognitoUserPoolId = props.cognitoUserPoolId ?? DEFAULT_COGNITO_USER_POOL_ID;
    const cognitoSpaClientId = props.cognitoSpaClientId ?? DEFAULT_COGNITO_SPA_CLIENT_ID;
    const cognitoUserPoolArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${cognitoUserPoolId}`;

    const makeFn = lambdaFactory(this, {
      corsOrigin: props.corsOrigin ?? '*',
      adminKeySecretName: ADMIN_KEY_SECRET_NAME,
    });

    // ---- facilitator marketplace ----
    const facilitatorsPublic = makeFn('FacilitatorsPublicFn', 'handlers/facilitators.ts', 'handler');
    const bookings = makeFn('BookingsFn', 'handlers/bookings.ts', 'handler');
    const facilitatorPortal = makeFn('FacilitatorPortalFn', 'handlers/facilitator-portal.ts', 'handler');
    const adminFacilitators = makeFn('AdminFacilitatorsFn', 'handlers/admin-facilitators.ts', 'handler');
    // Scheduled, not routed: releases lapsed slot holds and marks delivered
    // sessions completed so they become payable.
    const bookingSweep = makeFn('BookingSweepFn', 'handlers/booking-sweep.ts', 'handler');

    // ---- ticketed events ----
    // Buyer-facing registration, and the public read the registration page
    // loads. The latter is a second export of the same handler file that serves
    // GET /events — which itself lives in the CMS stack.
    const eventRegistrations = makeFn('EventRegistrationsFn', 'handlers/event-registrations.ts', 'handler');
    const eventsTicketing = makeFn('EventsTicketingFn', 'handlers/events.ts', 'ticketing');
    // Admin side of the same tables: roster, money, offline payments,
    // cancellations and the audit trail.
    const adminRegistrations = makeFn('AdminRegistrationsFn', 'handlers/admin-registrations.ts', 'handler');
    // Scheduled, not routed: releases lapsed holds, flags overdue instalments,
    // sends the four reminder tiers, and completes past events. Never touches
    // status on a missed payment — see the header comment in
    // registration-sweep.ts for why that is the product rule, not a gap.
    const registrationSweep = makeFn('RegistrationSweepFn', 'handlers/registration-sweep.ts', 'handler');
    // The cross-source people directory. Read-only, and no SES grant: it never
    // contacts anybody, it only says who there is to contact.
    const adminPeople = makeFn('AdminPeopleFn', 'handlers/admin-people.ts', 'handler');

    // ---- grants ----
    for (const fn of [
      facilitatorsPublic, bookings, facilitatorPortal, adminFacilitators, bookingSweep,
      eventRegistrations, eventsTicketing, adminRegistrations, registrationSweep, adminPeople,
    ]) {
      supabaseSecret.grantRead(fn);
    }

    // Both accept an admin-group token *or* the legacy shared key, so both need
    // to be able to read the key to compare against.
    adminKeySecret.grantRead(adminFacilitators);
    adminKeySecret.grantRead(adminRegistrations);
    adminKeySecret.grantRead(adminPeople);

    // Booking creation and event registration both open a PayMongo checkout
    // session, exactly as course checkout does. Grant and env var travel
    // together for the reason the paymongoSecretId prop documents: the grant
    // alone controls nothing at runtime, so a function with the grant but no
    // env var silently reads the *test* secret while holding a live grant.
    for (const fn of [bookings, eventRegistrations]) {
      paymongoSecret.grantRead(fn);
      fn.addEnvironment('PAYMONGO_SECRET_ID', paymongoSecretId);
    }

    // Every function that authenticates a caller from a Cognito id token needs
    // the pool id and SPA client id to build the verifier.
    for (const fn of [bookings, facilitatorPortal, adminFacilitators, eventRegistrations]) {
      fn.addEnvironment('COGNITO_USER_POOL_ID', cognitoUserPoolId);
      fn.addEnvironment('COGNITO_SPA_CLIENT_ID', cognitoSpaClientId);
    }

    // Approving or suspending a facilitator moves their Cognito group
    // membership, which is what actually grants or revokes dashboard access.
    // The groups themselves are declared in the core stack.
    adminFacilitators.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup'],
        resources: [cognitoUserPoolArn],
      }),
    );
    cognitoSecret.grantRead(adminFacilitators);

    // Booking confirmations, cancellations, reschedules, registration
    // receipts, reminders and the facilitator approval email. Granted per
    // function, so omitting one is a silent runtime failure rather than a
    // deploy error — which is exactly how a scheduled reminder ends up failing
    // with AccessDenied where nobody is watching a response code.
    //
    // paymongoWebhook and enrollmentRetryConsumer are absent because they live
    // in the core stack and are granted the same statement there.
    for (const fn of [
      bookings, facilitatorPortal, adminFacilitators, bookingSweep,
      eventRegistrations, adminRegistrations, registrationSweep,
    ]) {
      fn.addToRolePolicy(sesSendPolicy(this));
    }

    // The booking flow needs the same www-qualified origin as course checkout
    // for its PayMongo success/cancel URLs — see the note in checkout.ts about
    // why the apex domain breaks the return path — and the same activated
    // payment methods, since it opens sessions on the same account.
    for (const fn of [bookings, eventRegistrations]) {
      fn.addEnvironment('FRONTEND_URL', props.frontendUrl ?? DEFAULT_FRONTEND_URL);
      fn.addEnvironment('CHECKOUT_PAYMENT_METHODS', props.checkoutPaymentMethods ?? DEFAULT_CHECKOUT_PAYMENT_METHODS);
    }

    // Same address the DLQ alarm already notifies — one inbox for "something
    // needs a human", not a second one to remember to check.
    registrationSweep.addEnvironment('ADMIN_ALERT_EMAIL', props.alertEmail ?? DEFAULT_ALERT_EMAIL);
    // eventRegistrations also sends one of these — the cancellation-request
    // alert — the moment someone asks, rather than only via the sweep.
    eventRegistrations.addEnvironment('ADMIN_ALERT_EMAIL', props.alertEmail ?? DEFAULT_ALERT_EMAIL);

    // Five minutes bounds how long an abandoned checkout can keep a slot past
    // its 20-minute hold, which is the number that actually matters to someone
    // watching for an opening.
    new events.Rule(this, 'BookingSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(bookingSweep)],
    });

    // Same cadence and the same reasoning: five minutes bounds how long an
    // abandoned deposit checkout can keep a place past its hold, and a reminder
    // window is a day wide, so a missed cycle here is harmless either way.
    new events.Rule(this, 'RegistrationSweepRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(registrationSweep)],
    });

    // -----------------------------------------------------------------
    // Routes on the core stack's API.
    // -----------------------------------------------------------------
    const httpApi = apigw.HttpApi.fromHttpApiAttributes(this, 'HilomHttpApi', {
      httpApiId: props.httpApiId,
    });
    const attach = routeAttacher(this, httpApi);
    const { GET, POST, PUT, PATCH, DELETE } = apigw.HttpMethod;

    attach(facilitatorPortal, 'FacilitatorPortalInt', [
      // `/facilitators/apply` must out-specify `/facilitators/{slug}` or an
      // application POST would be read as a facilitator whose slug is "apply".
      // API Gateway prefers the exact match; listing it first is convention.
      ['/facilitators/apply', [POST]],
      ['/facilitator/me', [GET, PUT]],
      ['/facilitator/services', [GET, POST]],
      ['/facilitator/services/{serviceId}', [PUT, DELETE]],
      ['/facilitator/availability', [GET, PUT]],
      ['/facilitator/blackouts', [GET, POST]],
      ['/facilitator/blackouts/{blackoutId}', [DELETE]],
      ['/facilitator/bookings', [GET]],
      ['/facilitator/bookings/{bookingId}/cancel', [POST]],
      ['/facilitator/bookings/{bookingId}/no-show', [POST]],
      ['/facilitator/earnings', [GET]],
    ]);

    attach(facilitatorsPublic, 'FacilitatorsPublicInt', [
      ['/facilitators', [GET]],
      ['/facilitators/{slug}', [GET]],
      ['/facilitators/{slug}/availability', [GET]],
    ]);

    attach(bookings, 'BookingsInt', [
      ['/bookings', [POST]],
      ['/bookings/{bookingId}/status', [GET]],
      ['/bookings/{bookingId}/cancel', [POST]],
      ['/bookings/{bookingId}/reschedule', [POST]],
      ['/me/bookings', [GET]],
    ]);

    attach(adminFacilitators, 'AdminFacilitatorsInt', [
      ['/admin/facilitators', [GET, POST]],
      ['/admin/facilitators/{facilitatorId}', [GET, PATCH]],
      ['/admin/bookings', [GET]],
      ['/admin/bookings/{bookingId}/cancel', [POST]],
      ['/admin/bookings/{bookingId}/refund', [POST]],
      ['/admin/payouts', [GET, POST]],
      ['/admin/payouts/{payoutId}', [PATCH]],
    ]);

    attach(eventsTicketing, 'EventsTicketingInt', [['/events/{eventId}/ticketing', [GET]]]);

    attach(adminRegistrations, 'AdminRegistrationsInt', [
      // `/admin/events/{eventId}` itself is served by the CMS stack; these two
      // out-specify it and win on match specificity, across stacks.
      ['/admin/events/{eventId}/roster', [GET]],
      ['/admin/events/{eventId}/roster.csv', [GET]],
      ['/admin/audit-log', [GET]],
      ['/admin/registrations', [GET]],
      ['/admin/registrations/{registrationId}/cancel', [POST]],
      ['/admin/registrations/{registrationId}/cancellation-decision', [POST]],
      ['/admin/registrations/{registrationId}/refund-sent', [POST]],
      ['/admin/registrations/{registrationId}/price-override', [POST]],
      ['/admin/registrations/{registrationId}/nudge', [POST]],
      ['/admin/registrations/{registrationId}/charges/{chargeId}/mark-paid', [POST]],
      ['/admin/registrations/{registrationId}/charges/{chargeId}/waive', [POST]],
      ['/admin/registrations/{registrationId}/charges/{chargeId}/void', [POST]],
      ['/admin/registrations/{registrationId}', [GET]],
    ]);

    attach(adminPeople, 'AdminPeopleInt', [
      ['/admin/people.csv', [GET]],
      ['/admin/people', [GET]],
      ['/admin/people/{email}', [GET]],
    ]);

    attach(eventRegistrations, 'EventRegistrationsInt', [
      ['/events/{eventId}/register', [POST]],
      ['/me/registrations', [GET]],
      ['/registrations/{registrationId}/status', [GET]],
      ['/registrations/{registrationId}/pay-balance', [POST]],
      ['/registrations/{registrationId}/registrant', [PUT]],
      ['/registrations/{registrationId}/cancel-request', [POST]],
      ['/registrations/{registrationId}/charges/{chargeId}/pay', [POST]],
      ['/registrations/{registrationId}/charges/{chargeId}/receipt', [GET]],
      ['/registrations/{registrationId}', [GET]],
    ]);
  }
}
