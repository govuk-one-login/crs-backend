import { Capture, Match, Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "fs";
import { load } from "js-yaml";
import { schema } from "yaml-cfn";

// const { schema } = require("yaml-cfn");

// https://docs.aws.amazon.com/cdk/v2/guide/testing.html <--- how to use this file

const yamltemplate: any = load(readFileSync("template.yaml", "utf-8"), {
  schema: schema,
});

console.log("yamltemplate:" + yamltemplate);

const template = Template.fromJSON(yamltemplate, {
  skipCyclicalDependenciesCheck: true, // Note: canary alarms falsely trigger the circular dependency check. sam validate --lint (cfn-lint) can correctly handle this so we do not miss out here.
});

console.log("template:" + template);

describe("Backend application infrastructure", () => {
//   describe("CloudWatch alarms", () => {
//     test("All critical alerts should have runbooks defined", () => {
//       // to be updated only when a runbook exists for an alarm
//       const runbooksByAlarm: Record<string, boolean> = {
//         "high-threshold-revoke-4xx-api-gw": false,
//         "low-threshold-revoke-4xx-api-gw": false,
//         "high-threshold-revoke-5xx-api-gw": false,
//         "low-threshold-revoke-5xx-api-gw": false,
//         "api-gateway-latency": false,
//         "revoke-concurrency": false,
//         "revoke-throughput": false,
//       };

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