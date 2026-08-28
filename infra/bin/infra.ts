#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HilomCoreStack } from '../lib/hilom-core-stack';
import { HilomCmsStack } from '../lib/hilom-cms-stack';
import { HilomMarketplaceStack } from '../lib/hilom-marketplace-stack';

const app = new cdk.App();

// Region is pinned, never inherited from the CLI. The default profile on this
// machine is us-east-1, so an unpinned stack would silently deploy to the wrong
// region. Everything except the Amplify/CloudFront ACM certificate lives in
// ap-southeast-1 (Singapore).
const account = process.env.CDK_DEFAULT_ACCOUNT ?? '651706741660';
const env = { account, region: 'ap-southeast-1' };

// Set once the certificate finishes DNS validation. Until then the stack still
// deploys, just without the custom domain, so a pending DNS record never blocks
// backend work.
//   cdk deploy -c apiCertificateArn=arn:aws:acm:ap-southeast-1:...
const apiCertificateArn = app.node.tryGetContext('apiCertificateArn') as string | undefined;

/** Threaded into all three stacks so config is set in exactly one place. */
const common = {
  corsOrigin: app.node.tryGetContext('corsOrigin') as string | undefined,
  // Not a secret — the pool ID is just an identifier, unlike the app client
  // secret, which stays in hilom/cognito. Overridable via context in case the
  // pool is ever recreated.
  cognitoUserPoolId:
    (app.node.tryGetContext('cognitoUserPoolId') as string | undefined) ?? 'ap-southeast-1_AA9IeeZ2z',
  // Where DLQ alerts go. Override with: cdk deploy -c alertEmail=someone@else.com
  alertEmail: (app.node.tryGetContext('alertEmail') as string | undefined) ?? 'don.poky@gmail.com',
  // Which PayMongo credential set checkout/webhook/order-status read. Defaults
  // to test inside the stacks themselves — see HilomCommonProps'
  // paymongoSecretId doc comment. Going live:
  //   cdk deploy -c paymongoSecretId=hilom/paymongo/live
  paymongoSecretId: app.node.tryGetContext('paymongoSecretId') as string | undefined,
  // Event ids whose confirmation email attaches the participant agreement PDF.
  // Defaults to the Return to Self retreat inside the stack. Override with:
  //   cdk deploy -c participantAgreementEventIds=id1,id2
  participantAgreementEventIds: app.node.tryGetContext('participantAgreementEventIds') as
    | string
    | undefined,
};

// ---------------------------------------------------------------------------
// Three stacks, one API.
//
// The backend was a single stack until it reached CloudFormation's hard limit
// of 500 resources — two thirds of which is API Gateway wiring, three
// resources per endpoint. Splitting by domain gives each part room to grow.
//
// **The core stack's construct id is still `HilomBackendStack`.** That string
// is the deployed CloudFormation stack name. Changing it would not rename the
// stack; it would create a second one and orphan every bucket, secret, queue
// and Cognito group in the original. The class was renamed, the id was not.
// ---------------------------------------------------------------------------
const core = new HilomCoreStack(app, 'HilomBackendStack', {
  env,
  description: 'Hilom Collective — core: HTTP API, storefront, checkout, secrets, queues, buckets',
  apiCertificateArn,
  ...common,
});

const cms = new HilomCmsStack(app, 'HilomCmsStack', {
  env,
  description: 'Hilom Collective — CMS: pages, posts, menus, media, forms, event listings',
  httpApiId: core.httpApi.apiId,
  mediaBucket: core.mediaBucket,
  mediaCdnBase: `https://${core.mediaDistribution.distributionDomainName}`,
  ...common,
});

const marketplace = new HilomMarketplaceStack(app, 'HilomMarketplaceStack', {
  env,
  description: 'Hilom Collective — marketplace: facilitators, bookings, ticketed events, people',
  httpApiId: core.httpApi.apiId,
  ...common,
});

// Explicit, though the cross-stack references above already imply it: both
// stacks attach routes to an API the core stack owns, so the core must exist
// and must have finished releasing the routes they are about to claim.
cms.addDependency(core);
marketplace.addDependency(core);
