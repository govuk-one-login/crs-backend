process.env.ALARM_NAME = "TestAlarm";

import { mockClient } from "aws-sdk-client-mock";
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { handler } from "../../../src/functions/checkAlarmState";

const cloudwatchMock = mockClient(CloudWatchClient);

describe("checkAlarmState Lambda", () => {
  it("returns ALARM state when alarm is in ALARM", async () => {
    cloudwatchMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [{ StateValue: "ALARM" }],
    });

    const result = await handler({}, {} as AWSLambda.Context);
    expect(result).toEqual({ state: "ALARM" });
  });

  it("returns OK state when alarm is OK", async () => {
    cloudwatchMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [{ StateValue: "OK" }],
    });

    const result = await handler({}, {} as AWSLambda.Context);
    expect(result).toEqual({ state: "OK" });
  });

  it("returns INSUFFICIENT_DATA state when alarm is in INSUFFICIENT_DATA", async () => {
    cloudwatchMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [{ StateValue: "INSUFFICIENT_DATA" }],
    });

    const result = await handler({}, {} as AWSLambda.Context);
    expect(result).toEqual({ state: "INSUFFICIENT_DATA" });
  });

  it("returns UNKNOWN if no alarms are found", async () => {
    cloudwatchMock.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [],
    });

    const result = await handler({}, {} as AWSLambda.Context);
    expect(result).toEqual({ state: "UNKNOWN" });
  });

  it("returns UNKNOWN if ALARM_NAME is not set", async () => {
    delete process.env.ALARM_NAME;
    const result = await handler({}, {} as AWSLambda.Context);
    expect(result).toEqual({ state: "UNKNOWN" });
  });
});
