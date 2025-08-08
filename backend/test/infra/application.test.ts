import { Capture, Match, Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "fs";
import { load } from "js-yaml";
import { schema } from "yaml-cfn";
import { Mappings } from "./helpers/mappings";

interface CloudFormationTemplate {
  [key: string]: unknown;
}

interface FunctionDefinition {
  Properties: {
    DeploymentPreference: {
      Alarms: {
        "Fn::If": [string, Array<{ Ref: string }>, Array<{ Ref: string }>];
      };
    };
  };
}

const yamltemplate = load(readFileSync("template.yaml", "utf-8"), {
  schema: schema,
}) as CloudFormationTemplate;

console.log("yamltemplate:" + yamltemplate);

const template = Template.fromJSON(yamltemplate, {
  skipCyclicalDependenciesCheck: true,
});

console.log("template:" + template);

describe("Backend application infrastructure", () => {
  describe("DynamoDB Streams", () => {
    test("StatusListTable has streams enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        StreamSpecification: {
          StreamViewType: "KEYS_ONLY",
        },
      });
    });
  });

  describe("Event Source Mapping", () => {
    test("StatusListPublisherFunction is triggered by StatusChangeQueue", () => {
      template.hasResource("AWS::Lambda::EventSourceMapping", {
        Properties: {
          EventSourceArn: {
            "Fn::GetAtt": ["StatusChangeQueue", "Arn"],
          },
          FunctionName: {
            Ref: "StatusListPublisherFunction",
          },
        },
      });
    });
  });

  describe("EventBridge Pipe", () => {
    test("StatusChangeEventBridgePipe has correct MessageGroupId", () => {
      template.hasResourceProperties("AWS::Pipes::Pipe", {
        Source: {
          "Fn::GetAtt": ["StatusListTable", "StreamArn"],
        },
        SourceParameters: {
          FilterCriteria: {
            Filters: [
              {
                Pattern: '{ "eventName": ["MODIFY", "REMOVE"] }',
              },
            ],
          },
        },
        Target: {
          "Fn::GetAtt": ["StatusChangeQueue", "Arn"],
        },
        TargetParameters: {
          SqsQueueParameters: {
            MessageGroupId: "$.dynamodb.Keys.uri.S",
          },
        },
      });
    });

    test("StatusChangeEventBridgePipe and StatusChangeEventBridgePipeLogGroup follow consistent naming convention", () => {
      const eventBridgePipe =
        template.findResources("AWS::Pipes::Pipe")[
          "StatusChangeEventBridgePipe"
        ];
      const eventBridgePipeName = eventBridgePipe.Properties.Name["Fn::Sub"];

      const eventBridgePipeLogGroup = template.findResources(
        "AWS::Logs::LogGroup",
      )["StatusChangeEventBridgePipeLogGroup"];
      const eventBridgePipeLogGroupName =
        eventBridgePipeLogGroup.Properties.LogGroupName["Fn::Sub"].replace(
          "/aws/vendedlogs/pipes/",
          "",
        );

      expect(eventBridgePipeLogGroupName).toBe(eventBridgePipeName);
    });
  });

  describe("CloudWatch alarms", () => {
    test("All alarms are configured with a Condition", () => {
      const conditionalNames = [
        "DeployAlarms",
        "DeployMetricFilters",
        "DeployProxyAlarms",
      ];
      const alarms = Object.values(
        template.findResources("AWS::CloudWatch::Alarm"),
      );

      alarms.forEach((alarm) => {
        expect(conditionalNames).toContain(alarm.Condition);
      });
    });

    describe("Warning alarms", () => {
      test.each([
        ["revoke-concurrency"],
        ["revoke-throughput"],
        ["high-threshold-revoke-4xx-api-gw"],
        ["low-threshold-revoke-4xx-api-gw"],
        ["high-threshold-revoke-5xx-api-gw"],
        ["low-threshold-revoke-5xx-api-gw"],
        ["api-gateway-latency"],
        ["issue-status-list-entry-error-rate"],
        ["issue-status-list-entry-lambda-low-completion"],
        ["find-available-slots-error-rate"],
        ["find-available-slots-lambda-low-completion"],
        ["revoke-error-rate"],
        ["revoke-lambda-low-completion"],
        ["status-list-publisher-error-rate"],
        ["status-list-publisher-lambda-low-completion"],
      ])(
        "The %s alarm is configured to send an event to the warnings SNS topic on Alarm and OK actions",
        (alarmName: string) => {
          template.hasResourceProperties("AWS::CloudWatch::Alarm", {
            AlarmName: { "Fn::Sub": `\${AWS::StackName}-${alarmName}` },
            AlarmActions: [
              {
                "Fn::Sub":
                  "arn:aws:sns:${AWS::Region}:${AWS::AccountId}:platform-alarms-sns-warning",
              },
            ],
            OKActions: [
              {
                "Fn::Sub":
                  "arn:aws:sns:${AWS::Region}:${AWS::AccountId}:platform-alarms-sns-warning",
              },
            ],
            ActionsEnabled: true,
          });
        },
      );
    });

    describe("Canary Deployments", () => {
      it("Template parameter LambdaDeploymentPreference is present", () => {
        template.templateMatches({
          Parameters: {
            LambdaDeploymentPreference: {
              Type: "String",
              Default: "AllAtOnce",
            },
          },
        });
      });

      it("Global configuration defines default deployment preference values", () => {
        template.templateMatches({
          Globals: {
            Function: {
              DeploymentPreference: {
                Enabled: false,
                Role: { "Fn::GetAtt": ["CodeDeployServiceRole", "Arn"] },
              },
            },
          },
        });
      });

      const allFunctions = template.findResources("AWS::Serverless::Function");

      // Ensure new functions are tested for canary configuration by maintaining this list of exclusions
      const canaryFunctionExclusionList = [
        "CheckAlarmStateFunction",
        "ProxyLambda",
      ];

      const canaryFunctions = Object.entries(allFunctions).filter(
        ([functionName, _]) => {
          return !canaryFunctionExclusionList.includes(functionName);
        },
      );

      describe.each(canaryFunctions)(
        "Function definition - %s",
        (canaryFunction: string, canaryFunctionDefinition) => {
          it("correctly configures DeploymentPreference for canaries", () => {
            // Note: retrieveCanaryAlarmNames() relies on the following structure. Endeavour to both if the structure is being altered.
            expect(canaryFunctionDefinition).toMatchObject({
              Properties: {
                DeploymentPreference: {
                  Enabled: true,
                  Alarms: {
                    "Fn::If": [
                      "UseCanaryDeployment",
                      expect.any(Array),
                      [{ Ref: "AWS::NoValue" }],
                    ],
                  },
                  Type: {
                    Ref: "LambdaDeploymentPreference",
                  },
                },
              },
            });
          });

          const canaryFunctionAlarmNames = retrieveCanaryAlarmNames(
            canaryFunctionDefinition as FunctionDefinition,
          );

          const canaryFunctionAlarms = Object.entries(
            template.findResources("AWS::CloudWatch::Alarm"),
          ).filter(([alarmName, _]) => {
            return canaryFunctionAlarmNames?.includes(alarmName) ?? false;
          });

          // Each alarm used as for a canary deployment is required to reference the lambda function by lambda function version ensuring the alarm references the new version only.
          // The following assertions have redundancy. This is kept in as reference and to provide a backstop incase more complex canary alarms are required.
          if (canaryFunctionAlarms.length > 0) {
            it.each(canaryFunctionAlarms)(
              "Canary alarm %s references the function version",
              (_, alarmDefinition) => {
                alarmDefinition.Properties.Metrics.forEach(
                  (metricDataQuery: Record<string, unknown>) => {
                    const metricStat = metricDataQuery.MetricStat as Record<
                      string,
                      unknown
                    >;
                    if (metricStat) {
                      expect(metricStat.Period as unknown).toEqual(60);
                      expect(metricStat.Stat as unknown).toEqual("Sum");
                    }

                    // Simple test checking at least one dimension in one metric references the lambda function version.
                    expect(alarmDefinition.Properties.Metrics).toMatchObject(
                      expect.arrayContaining([
                        expect.objectContaining({
                          MetricStat: expect.objectContaining({
                            Metric: expect.objectContaining({
                              Dimensions: expect.arrayContaining([
                                {
                                  Name: expect.any(String),
                                  Value: {
                                    "Fn::GetAtt": [
                                      canaryFunction,
                                      "Version.Version",
                                    ],
                                  },
                                },
                              ]),
                            }),
                          }),
                        }),
                      ]),
                    );

                    // Specific test asserting that every metric using our custom metric log filters follows the same definition.
                    const metric = metricStat?.Metric as Record<
                      string,
                      unknown
                    >;
                    if (
                      metric &&
                      metric.Namespace &&
                      (metric.Namespace as Record<string, string>)["Fn::Sub"] ==
                        "${AWS::StackName}/LogMessages"
                    ) {
                      expect(metric.Dimensions).toEqual(
                        expect.arrayContaining([
                          {
                            Name: "MessageCode",
                            Value: expect.any(String),
                          },
                          {
                            Name: "Version",
                            Value: {
                              "Fn::GetAtt": [canaryFunction, "Version.Version"],
                            },
                          },
                        ]),
                      );
                    }

                    // Specific test asserting that every metric using the AWS metrics follows the same definition.
                    if (metric && metric.Namespace === "AWS/Lambda") {
                      expect(metric.Dimensions).toEqual(
                        expect.arrayContaining([
                          {
                            Name: "Resource",
                            Value: {
                              "Fn::Sub": "${" + canaryFunction + "}:live",
                            },
                          },
                          {
                            Name: "FunctionName",
                            Value: {
                              Ref: canaryFunction,
                            },
                          },
                          {
                            Name: "ExecutedVersion",
                            Value: {
                              "Fn::GetAtt": [canaryFunction, "Version.Version"],
                            },
                          },
                        ]),
                      );
                    }
                  },
                );
              },
            );
          }
        },
      );
    });
  });

  describe("SQS Queues", () => {
    describe("StatusChangeQueue", () => {
      test("StatusChangeQueue is configured as a FIFO queue", () => {
        template.hasResourceProperties("AWS::SQS::Queue", {
          QueueName: { "Fn::Sub": "${AWS::StackName}-StatusChangeQueue.fifo" },
          FifoQueue: true,
          ContentBasedDeduplication: true,
          MessageRetentionPeriod: 1209600,
        });
      });

      test("StatusChangeQueue has encryption configured", () => {
        template.hasResourceProperties("AWS::SQS::Queue", {
          QueueName: { "Fn::Sub": "${AWS::StackName}-StatusChangeQueue.fifo" },
          KmsMasterKeyId: { Ref: "StatusChangeQueueKeyAlias" },
        });
      });

      test("StatusChangeQueue has dead letter queue configured", () => {
        template.hasResourceProperties("AWS::SQS::Queue", {
          QueueName: { "Fn::Sub": "${AWS::StackName}-StatusChangeQueue.fifo" },
          RedrivePolicy: {
            deadLetterTargetArn: {
              "Fn::GetAtt": ["StatusChangeQueueDLQ", "Arn"],
            },
            maxReceiveCount: 10,
          },
        });
      });

      test("StatusChangeQueueDLQ is configured as a FIFO queue", () => {
        template.hasResourceProperties("AWS::SQS::Queue", {
          QueueName: {
            "Fn::Sub": "${AWS::StackName}-StatusChangeQueue-DLQ.fifo",
          },
          FifoQueue: true,
          MessageRetentionPeriod: 604800,
        });
      });

      test("StatusChangeQueueDLQ has encryption configured", () => {
        template.hasResourceProperties("AWS::SQS::Queue", {
          QueueName: {
            "Fn::Sub": "${AWS::StackName}-StatusChangeQueue-DLQ.fifo",
          },
          KmsMasterKeyId: { Ref: "StatusChangeQueueKeyAlias" },
        });
      });
    });

    describe("StatusChangeQueue KMS Key", () => {
      test("StatusChangeQueueEncryptionKey is configured correctly", () => {
        template.hasResourceProperties("AWS::KMS::Key", {
          Description:
            "A KMS Key for encrypting the Status Change FIFO SQS Queue",
          Enabled: true,
          KeySpec: "SYMMETRIC_DEFAULT",
          KeyUsage: "ENCRYPT_DECRYPT",
          MultiRegion: false,
        });
      });

      test("StatusChangeQueueKeyAlias is configured correctly", () => {
        template.hasResourceProperties("AWS::KMS::Alias", {
          AliasName: {
            "Fn::Sub": "alias/${AWS::StackName}-StatusChangeQueueEncryptionKey",
          },
          TargetKeyId: { Ref: "StatusChangeQueueEncryptionKey" },
        });
      });
    });

    describe("StatusChangeQueue Policy", () => {
      test("StatusChangeQueuePolicy allows cross-account access", () => {
        template.hasResourceProperties("AWS::SQS::QueuePolicy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Action: [
                  "SQS:DeleteMessage",
                  "SQS:GetQueueAttributes",
                  "SQS:ChangeMessageVisibility",
                  "SQS:ReceiveMessage",
                ],
                Effect: "Allow",
                Principal: {
                  AWS: Match.anyValue(),
                },
                Resource: [{ "Fn::GetAtt": ["StatusChangeQueue", "Arn"] }],
              },
            ]),
          },
        });
      });

      test("StatusChangeQueuePolicy allows receiveMessages for status list publisher lambda", () => {
        template.hasResourceProperties("AWS::SQS::QueuePolicy", {
          PolicyDocument: {
            Statement: Match.arrayWith([
              {
                Action: ["SQS:ReceiveMessage"],
                Effect: "Allow",
                Principal: {
                  Service: "lambda.amazonaws.com",
                },
                Resource: [{ "Fn::GetAtt": ["StatusChangeQueue", "Arn"] }],
                Condition: {
                  StringEquals: {
                    "AWS:SourceArn": {
                      "Fn::Sub":
                        "arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${StatusListPublisherFunction}",
                    },
                  },
                },
              },
            ]),
          },
        });
      });
    });
  });

  describe("Proxy APIgw", () => {
    test("The endpoints are Regional", () => {
      template.hasResourceProperties("AWS::Serverless::Api", {
        Name: { "Fn::Sub": "${AWS::StackName}-proxy-api" },
        EndpointConfiguration: {
          Type: "REGIONAL",
        },
      });
    });

    test("It uses the proxy async OpenAPI Spec", () => {
      template.hasResourceProperties("AWS::Serverless::Api", {
        Name: { "Fn::Sub": "${AWS::StackName}-proxy-api" },
        DefinitionBody: {
          "Fn::Transform": {
            Name: "AWS::Include",
            Parameters: {
              Location: "./openApiSpecs/crs-proxy-private-spec.yaml",
            },
          },
        },
      });
    });

    describe("APIgw method settings", () => {
      test("Metrics are enabled", () => {
        const methodSettings = new Capture();
        template.hasResourceProperties("AWS::Serverless::Api", {
          Name: { "Fn::Sub": "${AWS::StackName}-proxy-api" },
          MethodSettings: methodSettings,
        });
        expect(methodSettings.asArray()[0].MetricsEnabled).toBe(true);
      });

      test("Rate and burst limit mappings are set", () => {
        const expectedBurstLimits = {
          dev: 10,
          build: 10,
          staging: 10,
          integration: 0,
          production: 0,
        };
        const expectedRateLimits = {
          dev: 10,
          build: 10,
          staging: 10,
          integration: 0,
          production: 0,
        };
        const mappingHelper = new Mappings(template);
        mappingHelper.validateProxyAPIMapping({
          environmentFlags: expectedBurstLimits,
          mappingBottomLevelKey: "ApiBurstLimit",
        });
        mappingHelper.validateProxyAPIMapping({
          environmentFlags: expectedRateLimits,
          mappingBottomLevelKey: "ApiRateLimit",
        });
      });

      test("Rate limit and burst mappings are applied to the APIgw", () => {
        const methodSettings = new Capture();
        template.hasResourceProperties("AWS::Serverless::Api", {
          Name: { "Fn::Sub": "${AWS::StackName}-proxy-api" },
          MethodSettings: methodSettings,
        });
        expect(methodSettings.asArray()[0].ThrottlingBurstLimit).toStrictEqual({
          "Fn::FindInMap": [
            "ProxyApigw",
            { Ref: "Environment" },
            "ApiBurstLimit",
          ],
        });
        expect(methodSettings.asArray()[0].ThrottlingRateLimit).toStrictEqual({
          "Fn::FindInMap": [
            "ProxyApigw",
            { Ref: "Environment" },
            "ApiRateLimit",
          ],
        });
      });
    });

    test("Access log group is attached to APIgw", () => {
      template.hasResourceProperties("AWS::Serverless::Api", {
        Name: { "Fn::Sub": "${AWS::StackName}-proxy-api" },
        AccessLogSetting: {
          DestinationArn: {
            "Fn::GetAtt": ["CrsProxyApiAccessLogs", "Arn"],
          },
        },
      });
    });

    test("Access log group has a retention period", () => {
      const LogRetention = {
        dev: 30,
        build: 30,
        staging: 30,
        integration: 30,
        production: 30,
      };
      const mappingHelper = new Mappings(template);
      mappingHelper.validateLogRetentionMapping({
        environmentFlags: LogRetention,
        mappingBottomLevelKey: "RetentionPeriod",
      });
    });
  });

  // Pulls out a list of Alarm names used to configure canary deployments from function definition
  // Requires the function definition to match that as defined in the 'correctly configures DeploymentPreference for canaries' test
  // Aims to return undefined if that structure is not followed.
  function retrieveCanaryAlarmNames(
    functionDefinition: FunctionDefinition,
  ): string[] {
    if (
      !functionDefinition.Properties ||
      !functionDefinition.Properties.DeploymentPreference ||
      !functionDefinition.Properties.DeploymentPreference.Alarms ||
      !functionDefinition.Properties.DeploymentPreference.Alarms["Fn::If"] ||
      !functionDefinition.Properties.DeploymentPreference.Alarms["Fn::If"].at(1)
    ) {
      return [];
    }

    const canaryFunctionAlarms =
      functionDefinition.Properties.DeploymentPreference.Alarms["Fn::If"].at(1);

    if (!canaryFunctionAlarms || !Array.isArray(canaryFunctionAlarms)) {
      return [];
    }

    return canaryFunctionAlarms
      .filter((canaryFunctionAlarm: { Ref?: string }) => {
        return (
          typeof canaryFunctionAlarm === "object" && canaryFunctionAlarm.Ref
        );
      })
      .map((canaryFunctionAlarm: { Ref: string }) => {
        return canaryFunctionAlarm.Ref;
      });
  }
});
