import { expect } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SQSClient,
  GetQueueAttributesCommand,
  SendMessageBatchCommand,
  SendMessageBatchCommandOutput
} from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { Context } from 'aws-lambda';
import { findAvailableSlots } from '../../../src/functions/findAvailableSlotsHandler';
import * as loggerModule from '../../../src/common/logging/logger';
import { LogMessage } from '../../../src/common/logging/LogMessages';
import { sdkStreamMixin } from '@smithy/util-stream-node'

// Mock AWS clients
const mockSqsClient = mockClient(SQSClient);
const mockS3Client = mockClient(S3Client);

// Mock logger
jest.mock('../../../src/common/logging/logger', () => ({
  logger: {
    resetKeys: jest.fn(),
    addContext: jest.fn(),
    appendKeys: jest.fn(),
    info: jest.fn(),
    error: jest.fn()
  }
}));

// Get a reference to the mocked logger
const mockLogger = loggerModule.logger as jest.Mocked<typeof loggerModule.logger>;

// Define mock context for all tests
const mockContext: Context = {
  functionName: 'findAvailableSlots',
  functionVersion: '1',
  invokedFunctionArn: 'arn:aws:lambda:region:account:function:findAvailableSlots',
  memoryLimitInMB: '128',
  awsRequestId: '123456789',
  logGroupName: '/aws/lambda/findAvailableSlots',
  logStreamName: '2025/05/08/[$LATEST]123456789',
  identity: undefined,
  clientContext: undefined,
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 30000,
  done: () => { },
  fail: () => { },
  succeed: () => { }
};

// describe('findAvailableSlotsHandler', () => {

//   beforeEach(() => {
//     // Reset mocks between tests
//     mockSqsClient.reset();
//     mockS3Client.reset();
//     jest.clearAllMocks();

//     // Set environment variables
//     process.env.BITSTRING_QUEUE_URL = 'bitstring-queue-url';
//     process.env.TOKEN_STATUS_QUEUE_URL = 'token-status-queue-url';
//     process.env.LIST_CONFIGURATION_BUCKET = 'config-bucket';
//     process.env.CONFIGURATION_FILE_KEY = 'config.json';
//     process.env.TARGET_QUEUE_DEPTH = '100';
//   });

//   describe('Queue depth checks', () => {
//     it('should get queue depths successfully', async () => {
//       // Mock SQS response for GetQueueAttributesCommand
//       mockSqsClient.on(GetQueueAttributesCommand).resolves({
//         Attributes: {
//           ApproximateNumberOfMessages: '50'
//         }
//       });

//       // Mock S3 response to avoid errors
//       mockS3Client.on(GetObjectCommand).resolves({
//         Body: sdkStreamMixin(Readable.from([JSON.stringify({
//           bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
//           tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
//         })]))
//       });

//       // Mock SQS SendMessageBatch
//       mockSqsClient.on(SendMessageBatchCommand).resolves({
//         Successful: [{ Id: 'msg-0', MessageId: 'msg-id-0', MD5OfMessageBody: 'md5-hash' }],
//         Failed: [],
//         $metadata: { requestId: '12345', attempts: 1 }
//       });

//       const result = await findAvailableSlots(mockContext);

//       expect(result.statusCode).toBe(200);
//       expect(mockSqsClient.calls()).toHaveLength(4); // 2 GetQueueAttributes + 2 SendMessageBatch
//       expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Getting attributes for queue'));
//     });

//     it('should handle errors when getting queue attributes', async () => {
//       // Mock SQS to throw error for GetQueueAttributesCommand
//       mockSqsClient.on(GetQueueAttributesCommand).rejects(new Error('SQS error'));

//       // Mock S3 response
//       mockS3Client.on(GetObjectCommand).resolves({
//         Body: sdkStreamMixin(Readable.from([JSON.stringify({
//           bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
//           tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
//         })]))
//       });

//       const result = await findAvailableSlots(mockContext);

//       // Should still succeed with queue depths of 0
//       expect(result.statusCode).toBe(200);
//       expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Error getting queue attributes'), expect.any(Error));
//     });
//   });

//   describe('S3 Configuration', () => {
//     it('should fetch configuration successfully', async () => {
//       mockSqsClient.on(GetQueueAttributesCommand).resolves({
//         Attributes: { ApproximateNumberOfMessages: '50' }
//       });
  
//       const testConfig = {
//         bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
//         tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
//       };
  
//       mockS3Client.on(GetObjectCommand).resolves({
//         Body: sdkStreamMixin(Readable.from([JSON.stringify(testConfig)]))
//       });
//       mockSqsClient.on(SendMessageBatchCommand).resolves({
//         Successful: [{ Id: 'msg-0', MessageId: 'msg-id-0', MD5OfMessageBody: 'md5-hash' }],
//         Failed: [],
//         $metadata: { requestId: '12345', attempts: 1 }
//       });
      
//       const result = await findAvailableSlots(mockContext);
  
//       expect(result.statusCode).toBe(200);
//       expect(mockS3Client.calls()).toHaveLength(1);
//       expect(mockS3Client.calls()[0].args[0].input).toEqual({
//         Bucket: 'config-bucket',
//         Key: 'config.json'
//       });
//     });
//   });

//   it('should handle S3 errors when fetching configuration', async () => {
//     // Setup queue depths to require refill
//     mockSqsClient.on(GetQueueAttributesCommand).resolves({
//       Attributes: { ApproximateNumberOfMessages: '50' }
//     });

//     // Mock S3 error
//     mockS3Client.on(GetObjectCommand).rejects(new Error('S3 error'));

//     const result = await findAvailableSlots(mockContext);

//     expect(result.statusCode).toBe(500);
//     expect(JSON.parse(result.body).error).toBe('S3 error');
//     expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Error in lambda execution'), expect.any(Error));
//   });

//   it('should handle invalid JSON in configuration file', async () => {
//     mockSqsClient.on(GetQueueAttributesCommand).resolves({
//       Attributes: { ApproximateNumberOfMessages: '50' }
//     });

//     // Return invalid JSON
//     mockS3Client.on(GetObjectCommand).resolves({
//       Body: sdkStreamMixin(Readable.from(['not valid JSON']))
//     });

//     const result = await findAvailableSlots(mockContext);

//     expect(result.statusCode).toBe(500);
//     expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Error in lambda execution'), expect.any(Error));
//   });

//   it('should fetch configuration from S3 in isolation', async () => {
//     // Set up SQS to return queues that need refill but focus on S3
//     mockSqsClient.on(GetQueueAttributesCommand).resolves({
//       Attributes: { ApproximateNumberOfMessages: '50' }
//     });
//     mockSqsClient.on(SendMessageBatchCommand).resolves({
//       Successful: [],
//       Failed: [],
//       $metadata: { requestId: '12345', attempts: 1 }
//     });

//     const expectedConfig = {
//       bitstringStatusList: [
//         { uri: 'https://test1.example.com/bs', maxIndices: 1000, created: '2025-05-01', format: 'statuslist-v1' },
//         { uri: 'https://test2.example.com/bs', maxIndices: 2000, created: '2025-05-02', format: 'statuslist-v1' }
//       ],
//       tokenStatusList: [
//         { uri: 'https://test1.example.com/ts', maxIndices: 3000, created: '2025-05-03', format: 'statuslist-v1' },
//         { uri: 'https://test2.example.com/ts', maxIndices: 4000, created: '2025-05-04', format: 'statuslist-v1' }
//       ]
//     };

//     mockS3Client.on(GetObjectCommand).resolves({
//       Body: sdkStreamMixin(Readable.from([JSON.stringify(expectedConfig)]))
//     });

//     // Call the function
//     const result = await findAvailableSlots(mockContext);
//     expect(result.statusCode).toBe(200);

//     // Verify S3 client was called correctly
//     expect(mockS3Client.calls()).toHaveLength(1);
//     const s3Call = mockS3Client.calls()[0];
//     expect(s3Call.args[0].input).toEqual({
//       Bucket: 'config-bucket',
//       Key: 'config.json'
//     });

//     // Verify logs related to configuration
//     expect(mockLogger.info).toHaveBeenCalledWith('Fetching configuration from S3...');
//     expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Bucket: config-bucket, Key: config.json'));
//     expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Fetched configuration:'));

//     // Verify the minimum maxIndices is calculated correctly by checking the logs
//     expect(mockLogger.info).toHaveBeenCalledWith('Allocating 1000 indexes per endpoint');
//   });

//   it('should handle S3 fetch failure in isolation', async () => {
//     // Mock SQS to require refill
//     mockSqsClient.on(GetQueueAttributesCommand).resolves({
//       Attributes: { ApproximateNumberOfMessages: '0' }
//     });

//     // Focus on S3 error - make it fail with specific error
//     const expectedError = new Error('Access Denied - No permissions to read object');
//     expectedError.name = 'AccessDenied';
//     mockS3Client.on(GetObjectCommand).rejects(expectedError);

//     // Call the function
//     const result = await findAvailableSlots(mockContext);

//     // Verify error handling
//     expect(result.statusCode).toBe(500);
//     const body = JSON.parse(result.body);
//     expect(body.message).toBe('Error refilling queues');
//     expect(body.error).toBe('Access Denied - No permissions to read object');

//     // Verify error was logged
//     expect(mockLogger.error).toHaveBeenCalledWith(
//       'Error in lambda execution:',
//       expect.objectContaining({
//         name: 'AccessDenied',
//         message: 'Access Denied - No permissions to read object'
//       })
//     );

//     // Verify S3 call was made but no SQS SendMessageBatch calls
//     expect(mockS3Client.calls()).toHaveLength(1);
//     expect(mockSqsClient.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
//   });
// });

// describe('Queue message batching', () => {
//   // it('should send messages to queue in batches', async () => {
//   //   // Mock queue depth to be below target
//   //   mockSqsClient.on(GetQueueAttributesCommand).resolves({
//   //     Attributes: { ApproximateNumberOfMessages: '50' }
//   //   });

//   //   mockS3Client.on(GetObjectCommand).resolves({
//   //     Body: sdkStreamMixin(Readable.from([JSON.stringify({
//   //       bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
//   //       tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }],
//   //     })]))
//   //   });
//   //   mockSqsClient.on(SendMessageBatchCommand).resolves({
//   //     Successful: [{ Id: 'msg-0', MessageId: 'msg-id-0', MD5OfMessageBody: 'md5-hash' }],
//   //     Failed: [],
//   //     $metadata: { requestId: '12345', attempts: 1 }
//   //   } as SendMessageBatchCommandOutput);

//   //   const result = await findAvailableSlots(mockContext);

//   //   expect(result.statusCode).toBe(200);

//   //   // Check SendMessageBatchCommand was called
//   //   const sendMessageCalls = mockSqsClient.commandCalls(SendMessageBatchCommand);
//   //   expect(sendMessageCalls.length).toBeGreaterThan(0);

//   //   // Verify it was called with correct parameters
//   //   const sendMessageCall = sendMessageCalls[0];
//   //   expect(sendMessageCall.args[0].input.QueueUrl).toBeDefined();
//   //   expect(sendMessageCall.args[0].input.Entries.length).toBeGreaterThan(0);

//   //   // Verify each entry has required fields
//   //   sendMessageCall.args[0].input.Entries.forEach(entry => {
//   //     expect(entry.Id).toBeDefined();
//   //     expect(entry.MessageBody).toBeDefined();

//   //     // Verify message body is valid JSON with expected structure
//   //     const messageBody = JSON.parse(entry.MessageBody);
//   //     expect(messageBody).toHaveProperty('uri');
//   //     expect(messageBody).toHaveProperty('idx');
//   //   });
//   // });

//   it('should handle failures when sending messages', async () => {
//     // Mock queue depth to be below target
//     mockSqsClient.on(GetQueueAttributesCommand).resolves({
//       Attributes: { ApproximateNumberOfMessages: '50' }
//     });

//     mockS3Client.on(GetObjectCommand).resolves({
//       Body: sdkStreamMixin(Readable.from([JSON.stringify({
//         bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
//         tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
//       })]))
//     });
//     mockSqsClient.on(SendMessageBatchCommand).resolves({
//       Successful: [],
//       Failed: [{
//         Id: 'msg-0', Message: 'Failed to send message', SenderFault: true,
//         Code: undefined
//       }],
//       $metadata: { requestId: '12345', attempts: 1 }
//     });
//     mockSqsClient.on(SendMessageBatchCommand).resolves({
//       Successful: [],
//       Failed: [{ Id: 'msg-0', Message: 'Failed to send message', SenderFault: true, Code: undefined }],
//       $metadata: { requestId: '12345', attempts: 1 }
//     } as SendMessageBatchCommandOutput);

//     // Should still return success even with SQS send failures
//     const result = await findAvailableSlots(mockContext);
//     expect(result.statusCode).toBe(200);
//     expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send message'));
//   });
// });

describe('Main lambda handler', () => {
  it('should early terminate if both queues are full', async () => {
    // Mock queue depths to be at target
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '10000' }
    });

    const result = await findAvailableSlots(mockContext);

    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.message).toBe('No queue refill needed');

    // Verify S3 was not called as we early terminated
    expect(mockS3Client.calls().length).toBe(0);

    // Verify no SendMessageBatchCommand was called
    expect(mockSqsClient.commandCalls(SendMessageBatchCommand).length).toBe(0);
  });

  it('should refill one queue if it is below target', async () => {
    // First call returns bitstring queue depth (below target)
    // Second call returns token status queue depth (at target)
    // mockSqsClient.on(GetQueueAttributesCommand).callsFake((input) => {
    //   const queueUrl = input.QueueUrl;
    //   if (5 % 2 === 1) {
    //     return {
    //       Attributes: { ApproximateNumberOfMessages: '50' }
    //     };
    //   } else {
    //     return {
    //       Attributes: { ApproximateNumberOfMessages: '10000' }
    //     };
    //   }
    // });

    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{ Id: 'msg-0', MessageId: 'msg-id-0', MD5OfMessageBody: 'md5-hash' }],
      Failed: []
    });

    const result = await findAvailableSlots(mockContext);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.message).toBe('Successfully refilled queues');
    expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBe(0);
  });

  it('should refill both queues if they are both below target', async () => {
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{
        Id: 'msg-0',
        MessageId: undefined,
        MD5OfMessageBody: undefined
      }],
      Failed: []
    });

    const result = await findAvailableSlots(mockContext);
    expect(result.statusCode).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.message).toBe('Successfully refilled queues');
    expect(body.bitstringQueueStatus.messagesAdded).toBeGreaterThan(0);
    expect(body.tokenStatusQueueStatus.messagesAdded).toBeGreaterThan(0);
  });

  it('should handle empty endpoint lists in config', async () => {
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [],
        tokenStatusList: []
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{
        Id: 'msg-0',
        MessageId: undefined,
        MD5OfMessageBody: undefined
      }],
      Failed: []
    });

    const result = await findAvailableSlots(mockContext);
    expect(result.statusCode).toBe(200);

    // Should not throw errors with empty endpoint lists
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should handle edge case with very high maxIndexPerEndpoint', async () => {
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: Number.MAX_SAFE_INTEGER, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: Number.MAX_SAFE_INTEGER, created: '', format: '' }]
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{
        Id: 'msg-0',
        MessageId: undefined,
        MD5OfMessageBody: undefined
      }],
      Failed: []
    });

    const result = await findAvailableSlots(mockContext);
    expect(result.statusCode).toBe(200);

    // Should not throw errors with very large maxIndices
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should handle edge case with negative maxIndexPerEndpoint', async () => {
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: -10, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: -5, created: '', format: '' }]
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{
        Id: 'msg-0',
        MessageId: undefined,
        MD5OfMessageBody: undefined
      }],
      Failed: []
    });

    // Should handle negative maxIndices gracefully
    const result = await findAvailableSlots(mockContext);
    expect(result.statusCode).toBe(200);
  });

  it('should handle missing queue URLs', async () => {
    // Delete environment variables
    delete process.env.BITSTRING_QUEUE_URL;
    delete process.env.TOKEN_STATUS_QUEUE_URL;

    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
      })]))
    });

    const result = await findAvailableSlots(mockContext);

    // Should proceed with empty queue URLs
    expect(result.statusCode).toBe(200);
  });

  it('should log metrics of the refilling operation', async () => {
    mockSqsClient.on(GetQueueAttributesCommand).resolves({
      Attributes: { ApproximateNumberOfMessages: '50' }
    });

    mockS3Client.on(GetObjectCommand).resolves({
      Body: sdkStreamMixin(Readable.from([JSON.stringify({
        bitstringStatusList: [{ uri: 'https://example.com/bitstring', maxIndices: 100, created: '', format: '' }],
        tokenStatusList: [{ uri: 'https://example.com/token', maxIndices: 100, created: '', format: '' }]
      })]))
    });

    mockSqsClient.on(SendMessageBatchCommand).resolves({
      Successful: [{
        Id: 'msg-0',
        MessageId: undefined,
        MD5OfMessageBody: undefined
      }],
      Failed: []
    });

    await findAvailableSlots(mockContext);

    expect(mockLogger.info).toHaveBeenCalledWith(LogMessage.FAS_LAMBDA_STARTED);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/Bitstring queue: .* messages, need to add .*/));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/Token Status queue: .* messages, need to add .*/));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Selecting random indexes'));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringMatching(/Successfully refilled queues/));
  });
});