import {
  CloudWatchClient,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { Context } from "aws-lambda";

const cloudwatch = new CloudWatchClient({});

export const handler = async (
  _event: unknown,
  _context: Context,
): Promise<{ state: string }> => {
  const alarmName = process.env.ALARM_NAME;
  if (!alarmName) return { state: "NOT_SET" };
  const result = await cloudwatch.send(
    new DescribeAlarmsCommand({ AlarmNames: [alarmName] }),
  );
  const state = result.MetricAlarms?.[0]?.StateValue ?? "NO_ALARM";
  return { state };
};
