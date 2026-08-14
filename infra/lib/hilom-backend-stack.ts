import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

/**
 * Backend stack for Hilom Collective.
 *
 * Phase 0: intentionally empty — this exists so the app synthesizes and the
 * region pinning in bin/infra.ts is exercised before any real resource lands.
 * Phase 4 adds the HTTP API, custom domain, Lambdas and Secrets Manager entries;
 * Phase 6 adds the SQS retry queue, DLQ and SNS alert topic.
 */
export class HilomBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
