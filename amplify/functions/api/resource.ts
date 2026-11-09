import { defineFunction, secret } from '@aws-amplify/backend';

export const apiFunction = defineFunction({
  name: 'betta-service-api',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 29,
  memoryMB: 512,
  environment: {
    HOST: '0.0.0.0',
    PORT: '433',
    TRUST_PROXY: 'true',
    CALLBACK_MODE: 'mock',
    MAX_JSON_BODY: '2mb',
    MAX_FILE_SIZE_BYTES: '100000',
    ADMIN_TOKEN: secret('ADMIN_TOKEN'),
    INBOUND_API_KEY: secret('INBOUND_API_KEY')
  }
});