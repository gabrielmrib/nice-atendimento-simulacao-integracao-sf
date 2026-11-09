import { defineBackend } from '@aws-amplify/backend';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { apiFunction } from './functions/api/resource';

const backend = defineBackend({ apiFunction });
const stack = backend.createStack('betta-service-resources');

const conversations = new dynamodb.Table(stack, 'Conversations', {
  partitionKey: { name: 'identifier', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: false,
  removalPolicy: RemovalPolicy.DESTROY
});

backend.apiFunction.resources.lambda.addEnvironment('CONVERSATIONS_TABLE_NAME', conversations.tableName);
conversations.grantReadWriteData(backend.apiFunction.resources.lambda);

const appId = process.env.AWS_APP_ID;
const branch = process.env.AWS_BRANCH;
const defaultBranchOrigin = appId && branch
  ? `https://${branch}.${appId}.amplifyapp.com`
  : 'http://localhost:5173';
const extraOrigins = (process.env.AMPLIFY_FRONTEND_ORIGINS || '')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedOrigins = [...new Set([defaultBranchOrigin, ...extraOrigins])];

backend.apiFunction.resources.lambda.addEnvironment('CORS_ORIGIN', allowedOrigins.join(','));

const api = new apigatewayv2.HttpApi(stack, 'ServiceApi', {
  apiName: 'betta-service-api',
  corsPreflight: {
    allowOrigins: allowedOrigins,
    allowHeaders: ['content-type', 'x-admin-token', 'x-inbound-api-key'],
    allowMethods: [
      apigatewayv2.CorsHttpMethod.GET,
      apigatewayv2.CorsHttpMethod.POST,
      apigatewayv2.CorsHttpMethod.PUT,
      apigatewayv2.CorsHttpMethod.DELETE,
      apigatewayv2.CorsHttpMethod.OPTIONS
    ],
    maxAge: Duration.days(1)
  }
});

const integration = new HttpLambdaIntegration('ServiceApiIntegration', backend.apiFunction.resources.lambda);
api.addRoutes({ path: '/', methods: [apigatewayv2.HttpMethod.ANY], integration });
api.addRoutes({ path: '/{proxy+}', methods: [apigatewayv2.HttpMethod.ANY], integration });

backend.addOutput({
  custom: {
    api: {
      endpoint: api.apiEndpoint,
      region: Stack.of(api).region
    }
  }
});