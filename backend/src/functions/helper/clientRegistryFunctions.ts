import { Readable } from "stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Logger } from "@aws-lambda-powertools/logger";

// Define types for configuration
export interface StatusListEntry {
  jwksUri: string;
  type: string;
  format: string;
}

export interface ClientEntry {
  clientName: string;
  clientId: string;
  statusList: StatusListEntry;
}

export interface ClientRegistry {
  clients: ClientEntry[];
}

const CONFIG_BUCKET = process.env.CLIENT_REGISTRY_BUCKET ?? "";
const CONFIG_KEY = process.env.CLIENT_REGISTRY_FILE_KEY ?? "";

/**
 * Fetch the configuration from S3
 */
export async function getClientRegistryConfiguration(logger: Logger, s3Client) {
  logger.info("Fetching configuration from S3...");
  logger.info(`Bucket: ${CONFIG_BUCKET}, Key: ${CONFIG_KEY}`);
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY,
    });

    const response = await s3Client.send(command);
    const bodyText = await streamToString(response.Body as Readable);
    logger.info(`Fetched configuration: ${bodyText}`);
    return JSON.parse(bodyText) as ClientRegistry;
  } catch (error) {
    logger.error("Error fetching configuration from S3:", error);
    throw new Error("Error fetching configuration from S3");
  }
}

/**
 * Convert a readable stream to string
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
