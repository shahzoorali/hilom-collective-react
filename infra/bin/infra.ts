#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HilomBackendStack } from '../lib/hilom-backend-stack';

const app = new cdk.App();

// Region is pinned, never inherited from the CLI. The default profile on this
// machine is us-east-1, so an unpinned stack would silently deploy to the wrong
// region. Everything except the Amplify/CloudFront ACM certificate lives in
// ap-southeast-1 (Singapore).
const account = process.env.CDK_DEFAULT_ACCOUNT ?? '651706741660';

// Set once the certificate finishes DNS validation. Until then the stack still
// deploys, just without the custom domain, so a pending DNS record never blocks
// backend work.
//   cdk deploy -c apiCertificateArn=arn:aws:acm:ap-southeast-1:...
const apiCertificateArn = app.node.tryGetContext('apiCertificateArn') as string | undefined;

new HilomBackendStack(app, 'HilomBackendStack', {
  env: { account, region: 'ap-southeast-1' },
  description: 'Hilom Collective — API Gateway, Lambdas, secrets, enrollment queues',
  apiCertificateArn,
  corsOrigin: app.node.tryGetContext('corsOrigin') as string | undefined,
});
