import { Capture, Match, Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "fs";
import { load } from "js-yaml";
import { schema } from "yaml-cfn";

const yamltemplate: any = load(readFileSync("template.yaml", "utf-8"), {
  schema: schema,
});

console.log("yamltemplate:" + yamltemplate);

const template = Template.fromJSON(yamltemplate, {
  skipCyclicalDependenciesCheck: true,
});

console.log("template:" + template);

describe("Backend application infrastructure", () => {

  // describe('Canary Deployments', () => {
  //   it('Template parameter LambdaDeploymentPreference is present', () => {
  //     template.findParameters('LambdaDeploymentPreference', {
  //       Type: 'String',
  //       Default: 'AllAtOnce',
  //     })
  //   })
  // })

  //   it('Global configuration defines default deployment preference values', () => {
  //     template.templateMatches({
  //       Globals: {
  //         Function: {
  //           DeploymentPreference: {
  //             Enabled: false,
  //             Role: { 'Fn::GetAtt': ['CodeDeployServiceRole', 'Arn'] },
  //           },
  //         },
  //       },
  //     })
  //   })

  //   // Ensure new functions are tested for canary configuration by maintaining this list of exclusions
  //   const canaryFunctionExclusionList = [
  //     'CheckAlarmStateFunction',
  //   ]

  //   const allFunctions = template.findResources(
  //     'AWS::Serverless::Function',
  //   )

  //   const canaryFunctions = Object.entries(allFunctions).filter(
  //     ([functionName, _]) => {
  //       return !canaryFunctionExclusionList.includes(functionName)
  //     },
  //   )

describe("Backend application infrastructure", () => {
  describe("CloudWatch alarms", () => {
    test("All alarms are configured with a Condition", () => {
      const conditionalNames = [
        "DeployAlarms",
        "DeployMetricFilters",
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

        const canaryFunctionAlarmNames: any = retrieveCanaryAlarmNames(
          canaryFunctionDefinition,
        );

        const canaryFunctionAlarms = Object.entries(
          template.findResources("AWS::CloudWatch::Alarm"),
        ).filter(([alarmName, _]) => {
          return canaryFunctionAlarmNames.includes(alarmName);
        });

        // Each alarm used as for a canary deployment is required to reference the lambda function by lambda function version ensuring the alarm references the new version only.
        // The following assertions have redundancy. This is kept in as reference and to provide a backstop incase more complex canary alarms are required.
        if (canaryFunctionAlarms.length > 0) {
          it.each(canaryFunctionAlarms)(
            "Canary alarm %s references the function version",
            (_, alarmDefinition) => {
              alarmDefinition.Properties.Metrics.forEach(
                (metricDataQuery: any) => {
                  if (metricDataQuery.MetricStat) {
                    expect(metricDataQuery.MetricStat.Period).toEqual(60);
                    expect(metricDataQuery.MetricStat.Stat).toEqual("Sum");
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
                  if (
                    metricDataQuery.MetricStat?.Metric?.Namespace &&
                    metricDataQuery.MetricStat?.Metric?.Namespace["Fn::Sub"] ==
                      "${AWS::StackName}/LogMessages"
                  ) {
                    expect(
                      metricDataQuery.MetricStat.Metric.Dimensions,
                    ).toEqual(
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
                  if (
                    metricDataQuery.MetricStat?.Metric?.Namespace ===
                    "AWS/Lambda"
                  ) {
                    expect(
                      metricDataQuery.MetricStat.Metric.Dimensions,
                    ).toEqual(
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

// Pulls out a list of Alarm names used to configure canary deployments from function definition
// Requires the function definition to match that as defined in the 'correctly configures DeploymentPreference for canaries' test
// Aims to return undefined if that structure is not followed.
function retrieveCanaryAlarmNames(functionDefinition: {
  [key: string]: any; // eslint-disable-line  @typescript-eslint/no-explicit-any
}): string[] | undefined {
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

  return canaryFunctionAlarms
    .filter((canaryFunctionAlarm: any) => {
      return typeof canaryFunctionAlarm === "object" && canaryFunctionAlarm.Ref;
    })
    .map((canaryFunctionAlarm: any) => {
      return canaryFunctionAlarm.Ref;
    });
}

});
});
