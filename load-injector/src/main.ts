import {DynamoDBClient, DynamoDBClientConfig, PutItemCommand, PutItemCommandInput} from "@aws-sdk/client-dynamodb";

const LOCAL_TABLE_NAME = "backend-crs-ddunford-StatusListTable"
const GLOBAL_TABLE_NAME = "backend-crs-ddunford-StatusListGlobalTable"
const GLOBAL_TABLE_NAME_PARIS = "backend-crs-ddunford-StatusListGlobalTableParis"
const GLOBAL_TABLE_NAME_EC = "backend-crs-ddunford-StatusListGlobalTableEC"
const START_INDEX = 7000;
const MAX_SOCKETS = 100;
const MAX_HTTPS_TIMEOUT_IN_MS = 10000;
const MAX_ATTEMPTS = 10;
const ITEM_TTL_IN_SECS = 3600*48;  // 48 hours

const config: DynamoDBClientConfig = {
  region: "eu-west-2",
  maxAttempts: MAX_ATTEMPTS,
  requestHandler: {
    requestTimeout: MAX_HTTPS_TIMEOUT_IN_MS,
    httpsAgent: {maxSockets: MAX_SOCKETS},
  },
}
const client = new DynamoDBClient(config);
const ttl = Math.floor(Number(new Date()) / 1000) + ITEM_TTL_IN_SECS // TTL 1 hour

const fakeItemFactory = (idx: number) => {
  return {
    "uri": {
      "S": "B2757C3F6091"
    },
    "idx": {
      "N": String(idx)
    },
    "clientId": {
      "S": "asKWnsjeEJEWjjwSHsIksIksIhBe"
    },
    "exp": {
      "N": String(ttl)
    },
    "issuedAt": {
      "N": String(Math.floor(Number(new Date()) / 1000)),
    },
    "issuer": {
      "S": "OVA"
    },
    "listType": {
      "S": "BitstringStatusList"
    }
  }
}

const insertItemsIntoTable = async (tableName: string, numberOfItemsToInsert: number, start: number) => {
  for (let i = 0; i < numberOfItemsToInsert; i++) {
    const putItemCommandInput: PutItemCommandInput = {
      Item: fakeItemFactory(start + i),
      TableName: tableName,
    }
    const putItemCommand = new PutItemCommand(putItemCommandInput);
    await client.send(putItemCommand)
  }
}

const runTest = async () => {

  // PutItem into Local Table
  console.log("Starting Local Insert")
  const startTimeLocal = new Date();
  await insertItemsIntoTable(LOCAL_TABLE_NAME, 1000, START_INDEX)
  const endTimeLocal = new Date();
  const elapsedSecondsLocal = (endTimeLocal.getTime() - startTimeLocal.getTime()) / 1000;
  console.log(`Completed in ${elapsedSecondsLocal} seconds`);

  // PutItem into Global Table with MRSC
  console.log("Starting Global Insert")
  const startTimeGlobal = new Date();
  await insertItemsIntoTable(GLOBAL_TABLE_NAME, 1000, START_INDEX)
  const endTimeGlobal = new Date();
  const elapsedSecondsGlobal = (endTimeGlobal.getTime() - startTimeGlobal.getTime()) / 1000;
  console.log(`Completed in ${elapsedSecondsGlobal} seconds`);

  // PutItem into Global Table with MRSC in Paris
  console.log("Starting Global Insert with Paris")
  const startTimeGlobalParis = new Date();
  await insertItemsIntoTable(GLOBAL_TABLE_NAME_PARIS, 1000, START_INDEX)
  const endTimeGlobalParis = new Date();
  const elapsedSecondsGlobalParis = (endTimeGlobalParis.getTime() - startTimeGlobalParis.getTime()) / 1000;
  console.log(`Completed in ${elapsedSecondsGlobalParis} seconds`);

  // PutItem into Global Table with MREC in Dublin
  console.log("Starting Global Insert with Dublin MREC")
  const startTimeGlobalEc = new Date();
  await insertItemsIntoTable(GLOBAL_TABLE_NAME_EC, 1000, START_INDEX)
  const endTimeGlobalEd = new Date();
  const elapsedSecondsGlobalEc = (endTimeGlobalEd.getTime() - startTimeGlobalEc.getTime()) / 1000;
  console.log(`Completed in ${elapsedSecondsGlobalEc} seconds`);
}

runTest().then(() => {
  console.log("DONE")
}).catch((error) => {
  console.error(error);
})
