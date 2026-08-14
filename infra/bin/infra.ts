#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HilomBackendStack } from '../lib/hilom-backend-stack';

const app = new cdk.App();

// Region is pinned, never inherited from the CLI. The default profile on this
// machine is us-east-1, so an unpinned stack would silently deploy to the wrong
// region. Everything except the Amplify/CloudFront ACM certificate lives in
// ap-southeast-1 (Singapore).
const account = process.env.CDK_DEFAULT_ACCOUNT ?? '651706741660';

new HilomBackendStack(app, 'HilomBackendStack', {
  env: { account, region: 'ap-southeast-1' },
  description: 'Hilom Collective — API Gateway, Lambdas, secrets, enrollment queues',
});
