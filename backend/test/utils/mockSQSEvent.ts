import { SQSEvent } from "aws-lambda";

export function createSQSEvent(messageGroupId: string): SQSEvent {
  return {
    Records: [
      {
        messageId: "1",
        receiptHandle: "abc",
        body: '{"test":"value"}',
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "1234567890",
          MessageGroupId: messageGroupId,
        },
        messageAttributes: {},
        md5OfBody: "md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:region:account-id:queue-name",
        awsRegion: "region",
      },
    ],
  };
}

export function createMultipleRecordSQSEvent(
  messageGroupId: string,
  messageGroupId2: string,
): SQSEvent {
  return {
    Records: [
      {
        messageId: "1",
        receiptHandle: "abc",
        body: '{"test":"value"}',
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "1234567890",
          MessageGroupId: messageGroupId,
        },
        messageAttributes: {},
        md5OfBody: "md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:region:account-id:queue-name",
        awsRegion: "region",
      },
      {
        messageId: "2",
        receiptHandle: "def",
        body: '{"test":"value"}',
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890",
          SenderId: "sender",
          ApproximateFirstReceiveTimestamp: "1234567890",
          MessageGroupId: messageGroupId2,
        },
        messageAttributes: {},
        md5OfBody: "md5",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:region:account-id:queue-name",
        awsRegion: "region",
      },
    ],
  };
}
