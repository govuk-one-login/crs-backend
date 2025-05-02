import { LogAttributes } from "@aws-lambda-powertools/logger/types";

export class LogMessage implements LogAttributes {
  static readonly FAS_LAMBDA_STARTED = new LogMessage(
    "FAS_LAMBDA_STARTED",
    "FindAvailableSlots Lambda handler processing has started.",
    "N/A",
  );

  private constructor(
    public readonly messageCode: string,
    public readonly message: string,
    public readonly userImpact: string,
  ) {}

  [key: string]: string; // Index signature needed to implement LogAttributesWithMessage
}