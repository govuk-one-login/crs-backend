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
  describe("Warning alarms", () => {
    test.each([
      ["revoke-concurrency"],
      ["revoke-throughput"],
      ["high-threshold-revoke-4xx-api-gw"],
      ["low-threshold-revoke-4xx-api-gw"],
      ["high-threshold-revoke-5xx-api-gw"],
      ["low-threshold-revoke-5xx-api-gw"],
      ["api-gateway-latency"],
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
});
