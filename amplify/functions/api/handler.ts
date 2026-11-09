import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from '../../../server';
import { DynamoConversationStore } from './dynamo-store';

const store = new DynamoConversationStore(process.env.CONVERSATIONS_TABLE_NAME || '');
const app = createApp({ store, serveStatic: false });

export const handler = serverlessExpress({ app });