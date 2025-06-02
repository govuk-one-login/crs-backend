import { LogAttributes } from "@aws-lambda-powertools/logger/types";

export class LogMessage implements LogAttributes {
  static readonly FAS_LAMBDA_STARTED = new LogMessage(
    "FAS_LAMBDA_STARTED",
    "FindAvailableSlots Lambda handler processing has started.",
    "N/A",
  );

  static readonly ISSUE_LAMBDA_STARTED = new LogMessage(
    "ISSUE_LAMBDA_STARTED",
    "IssuingStatusListEntry Lambda handler processing has started.",
    "N/A",
  );

  static readonly SEND_MESSAGE_TO_SQS_FAILURE = new LogMessage(
    "CRS_SEND_MESSAGE_TO_SQS_FAILURE",
    "An unexpected failure occurred while attempting to write message to SQS.",
    "N/A",
  );

  static readonly SEND_MESSAGE_TO_SQS_SUCCESS = new LogMessage(
    "CRS_SEND_MESSAGE_TO_SQS_SUCCESS",
    "An audit txma event has been successfully sent to SQS.",
    "N/A",
  );

  static readonly REVOKE_LAMBDA_CALLED = new LogMessage(
    "REVOKE_LAMBDA_CALLED",
    "Revoke handler has been called.",
    "N/A",
  );

  private constructor(
    public readonly messageCode: string,
    public readonly message: string,
    public readonly userImpact: string,
  ) {}

  [key: string]: string; // Index signature needed to implement LogAttributesWithMessage
}
