import { TxmaEvent } from "../../common/types";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { logger } from "../../common/logging/logger";
import { LogMessage } from "../../common/logging/LogMessages";

const TXMA_QUEUE_URL = process.env.TXMA_QUEUE_URL ?? "";

export async function sendTxmaEventToSQSQueue(
  sqsClient: SQSClient,
  txmaEvent: TxmaEvent,
) {
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: TXMA_QUEUE_URL,
        MessageBody: JSON.stringify(txmaEvent),
      }),
    );
  } catch (error) {
    logger.error(LogMessage.SEND_MESSAGE_TO_SQS_FAILURE, {
      error,
    });
    throw Error(
      `Failed to send TXMA Event: ${JSON.stringify(txmaEvent)} to sqs, error: ${error}`,
    );
  }
}
