/**
 * SES delivery events — the one Hilom stack outside ap-southeast-1.
 *
 * SES sends from ap-south-1 (see SES_REGION), and a configuration set's event
 * destination can only publish to an SNS topic in its own region. So the
 * configuration set and topic live here; the Lambda that records outcomes stays
 * in Singapore (HilomMarketplaceStack) and subscribes to this topic across
 * regions.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { SES_EVENTS_CONFIGURATION_SET, SES_EVENTS_TOPIC_NAME } from './hilom-shared';

export class HilomSesEventsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const topic = new sns.Topic(this, 'SesEventsTopic', { topicName: SES_EVENTS_TOPIC_NAME });
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [topic.topicArn],
        conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
      }),
    );

    const configurationSet = new ses.ConfigurationSet(this, 'TransactionalConfigurationSet', {
      configurationSetName: SES_EVENTS_CONFIGURATION_SET,
      // Hilom's emails are receipts and reminders; reputation metrics on.
      reputationMetrics: true,
    });

    // `Send` is left out: the sweep already records the send itself.
    configurationSet.addEventDestination('ToSns', {
      destination: ses.EventDestination.snsTopic(topic),
      events: [
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });
  }
}
