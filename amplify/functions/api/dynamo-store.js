const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand
} = require('@aws-sdk/lib-dynamodb');

const MAX_ITEM_BYTES = 350 * 1024;

class DynamoConversationStore {
  constructor(tableName, client = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
    if (!tableName) throw new Error('CONVERSATIONS_TABLE_NAME is required.');
    this.tableName = tableName;
    this.client = client;
  }

  async get(identifier) {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { identifier }
    }));
    return result.Item;
  }

  async set(identifier, value) {
    const item = { ...value, identifier };
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_ITEM_BYTES) {
      const error = new Error('Conversa muito grande para armazenamento DynamoDB; reduza histórico ou anexo.');
      error.status = 413;
      throw error;
    }
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async listConversations() {
    const conversations = [];
    let lastEvaluatedKey;
    do {
      const result = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'attribute_not_exists(#system)',
        ExpressionAttributeNames: { '#system': '_system' },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      conversations.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return conversations;
  }

  async clearConversations() {
    let lastEvaluatedKey;
    do {
      const result = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'attribute_not_exists(#system)',
        ExpressionAttributeNames: { '#system': '_system' },
        ProjectionExpression: '#identifier',
        ExpressionAttributeNames: { '#system': '_system', '#identifier': 'identifier' },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      const items = result.Items || [];
      for (let offset = 0; offset < items.length; offset += 25) {
        await this.client.send(new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: items.slice(offset, offset + 25).map((item) => ({
              DeleteRequest: { Key: { identifier: item.identifier } }
            }))
          }
        }));
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }
}

module.exports = { DynamoConversationStore };
