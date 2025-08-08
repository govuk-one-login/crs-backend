import { LogAttributes } from "@aws-lambda-powertools/logger/types";

export class LogMessage implements LogAttributes {
  static readonly FAS_LAMBDA_STARTED = new LogMessage(
    "FAS_LAMBDA_STARTED",
    "FindAvailableSlots Lambda handler processing has started.",
    "N/A",
  );

  static readonly ISSUE_STATUS_LIST_ENTRY_LAMBDA_STARTED = new LogMessage(
    "ISSUE_STATUS_LIST_ENTRY_LAMBDA_STARTED",
    "IssuingStatusListEntry Lambda handler processing has started.",
    "N/A",
  );

  static readonly ISSUE_STATUS_LIST_ENTRY_LAMBDA_COMPLETED = new LogMessage(
    "ISSUE_STATUS_LIST_ENTRY_LAMBDA_COMPLETED",
    "IssuingStatusListEntry Lambda handler processing has completed.",
    "N/A",
  );

  static readonly FIND_AVAILABLE_SLOTS_LAMBDA_STARTED = new LogMessage(
    "FIND_AVAILABLE_SLOTS_LAMBDA_STARTED",
    "FindAvailableSlots Lambda handler processing has started.",
    "N/A",
  );

  static readonly FIND_AVAILABLE_SLOTS_LAMBDA_COMPLETED = new LogMessage(
    "FIND_AVAILABLE_SLOTS_LAMBDA_COMPLETED",
    "FindAvailableSlots Lambda handler processing has completed.",
    "N/A",
  );

  static readonly REVOKE_LAMBDA_STARTED = new LogMessage(
    "REVOKE_LAMBDA_STARTED",
    "Revoke Lambda handler processing has started.",
    "N/A",
  );

  static readonly REVOKE_LAMBDA_COMPLETED = new LogMessage(
    "REVOKE_LAMBDA_COMPLETED",
    "Revoke Lambda handler processing has completed.",
    "N/A",
  );

  static readonly STATUS_LIST_PUBLISHER_LAMBDA_STARTED = new LogMessage(
    "STATUS_LIST_PUBLISHER_LAMBDA_STARTED",
    "StatusListPublisher Lambda handler processing has started.",
    "N/A",
  );

  static readonly STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED = new LogMessage(
    "STATUS_LIST_PUBLISHER_LAMBDA_COMPLETED",
    "StatusListPublisher Lambda handler processing has completed.",
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

  static readonly PROXY_LAMBDA_STARTED = new LogMessage(
    "PROXY_LAMBDA_STARTED",
    "Proxy Lambda handler processing has started.",
    "N/A",
  );

  static readonly PROXY_LAMBDA_COMPLETED = new LogMessage(
    "PROXY_LAMBDA_COMPLETED",
    "Proxy Lambda handler processing has completed.",
    "N/A",
  );
  static readonly PROXY_UNEXPECTED_PATH = new LogMessage(
    "PROXY_UNEXPECTED_PATH",
    "Proxy encountered an unexpected path.",
    "N/A",
  );

  static readonly PROXY_UNEXPECTED_HTTP_METHOD = new LogMessage(
    "PROXY_UNEXPECTED_HTTP_METHOD",
    "Proxy encountered an unexpected http method.",
    "N/A",
  );
  static readonly PROXY_REQUEST_ERROR = new LogMessage(
    "PROXY_REQUEST_ERROR",
    "Proxy encountered an error when making a request to the private apigw.",
    "N/A",
  );
  static readonly PROXY_INVALID_CONFIG = new LogMessage(
    "PROXY_INVALID_CONFIG",
    "A required environment variable is missing or invalid.",
    "N/A",
  );

  private constructor(
    public readonly messageCode: string,
    public readonly message: string,
    public readonly userImpact: string,
  ) {}

  [key: string]: string; // Index signature needed to implement LogAttributesWithMessage
}
