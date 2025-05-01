import { LogAttributes } from "@aws-lambda-powertools/logger/types";

export class LogMessage implements LogAttributes {
  static readonly ISSUE_LAMBDA_STARTED = new LogMessage(
    "ISSUE_LAMBDA_STARTED",
    "IssuingStatusListEntry Lambda handler processing has started.",
    "N/A",
  );

  private constructor(
    public readonly messageCode: string,
    public readonly message: string,
    public readonly userImpact: string,
  ) {}

  [key: string]: string; // Index signature needed to implement LogAttributesWithMessage
}
