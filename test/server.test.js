const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const WebSocket = require('ws');
const { createApp, createServer, validateNetworkSettings } = require('../server');

function openPayload(identifier = 'session-test-1') {
  return {
    action: 'OPEN_CONVERSATION', identifier, conversationId: 'conversation-test-1', requestId: 'request-test-1',
    skillId: '35629200', QueueNice: 'SEGURO',
    parameters: { contact: { name: 'Cliente Teste', channel: 'whatsapp', history: [{ sender: 'user', message: { text: 'Olá' } }] }, extraInfo: { CanalOperacao: 'porto_cartoes' } }
  };
}

test('OAuth simulado valida credenciais e retorna contrato fictício', async () => {
  const app = createApp({ oauthClientId: 'test-client', oauthClientSecret: 'test-secret' });
  const accepted = await request(app).post('/api/Agent/1.0/token').send({ grant_type: 'client_credentials', client_id: 'test-client', client_secret: 'test-secret' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.token_type, 'Bearer');
  const rejected = await request(app).post('/api/NiceConversations/1.0/token').send({ grant_type: 'client_credentials', client_id: 'wrong', client_secret: 'wrong' });
  assert.equal(rejected.status, 401);
});

test('abertura é idempotente e publica conversa na fila', async () => {
  const app = createApp();
  const events = [];
  app.locals.broadcast = (event, data) => events.push({ event, data });
  const first = await request(app).post('/api/customer/events').send(openPayload());
  const duplicate = await request(app).post('/api/customer/events').send(openPayload());
  const list = await request(app).get('/api/agent/conversations');
  assert.equal(first.status, 200);
  assert.equal(first.body.requestId, 'request-test-1');
  assert.equal(duplicate.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].status, 'QUEUED');
  assert.equal(events.filter(({ event }) => event === 'NEW_QUEUED_CONVERSATION').length, 1);
});

test('mensagens recebidas atualizam o histórico e conversa fechada não reabre', async () => {
  const app = createApp();
  await request(app).post('/eventsLegacy').send(openPayload());
  const incoming = await request(app).post('/api/customer/events').send({ action: 'SEND_MESSAGE', identifier: 'session-test-1', parameters: { messages: ['Preciso de ajuda'] } });
  assert.equal(incoming.status, 200);
  let conversation = (await request(app).get('/api/agent/conversations/session-test-1')).body;
  assert.equal(conversation.messages.at(-1).text, 'Preciso de ajuda');
  await request(app).post('/api/customer/events').send({ action: 'CLOSE_CONVERSATION', identifier: 'session-test-1' });
  const rejected = await request(app).post('/api/customer/events').send({ action: 'SEND_MESSAGE', identifier: 'session-test-1', parameters: { messages: ['Depois do fechamento'] } });
  assert.equal(rejected.status, 409);
});

test('ações do atendente funcionam em modo local sem webhook externo', async () => {
  const app = createApp({ callbackMode: 'mock' });
  await request(app).post('/api/customer/events').send(openPayload());
  const accepted = await request(app).post('/api/agent/conversations/session-test-1/accept').send();
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.conversation.status, 'ACTIVE');
  assert.equal(accepted.body.delivery.delivery, 'simulated');
  const sent = await request(app).post('/api/agent/conversations/session-test-1/messages').send({ message: 'Estou verificando para você.' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.conversation.messages.at(-1).sender, 'agent');
  const closed = await request(app).post('/api/agent/conversations/session-test-1/close').send();
  assert.equal(closed.status, 200);
  assert.equal(closed.body.conversation.status, 'CLOSED');
});

test('falha no callback HTTP restaura conversa à fila', async () => {
  const app = createApp({ callbackMode: 'http', webhookUrl: 'https://example.test/hook', callbackSender: async () => { throw new Error('offline'); } });
  await request(app).post('/api/customer/events').send(openPayload());
  const failed = await request(app).post('/api/agent/conversations/session-test-1/accept').send();
  assert.equal(failed.status, 502);
  const conversation = (await request(app).get('/api/agent/conversations/session-test-1')).body;
  assert.equal(conversation.status, 'QUEUED');
});

test('callback Salesforce obtém token client_credentials e envia Bearer', async () => {
  const calls = [];
  const app = createApp({
    callbackMode: 'http',
    webhookUrl: 'https://org.example.test/services/apexrest/BettaWebhookCallback',
    salesforceTokenUrl: 'https://org.example.test/services/oauth2/token',
    salesforceClientId: 'connected-app-id',
    salesforceClientSecret: 'test-secret',
    salesforceRequest: {
      async post(url, body, options) {
        calls.push({ url, body, options });
        if (url.endsWith('/services/oauth2/token')) return { data: { access_token: 'oauth-token-test', expires_in: 3600 } };
        return { data: { success: true } };
      }
    }
  });
  await request(app).post('/api/customer/events').send(openPayload());
  const accepted = await request(app).post('/api/agent/conversations/session-test-1/accept').send();
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body, /grant_type=client_credentials/);
  assert.match(calls[0].body, /client_secret=test-secret/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer oauth-token-test');
});

test('endpoint OAuth HTTP é recusado antes de enviar Client Secret', async () => {
  let requests = 0;
  const app = createApp({
    callbackMode: 'http', webhookUrl: 'https://org.example.test/callback',
    salesforceTokenUrl: 'http://example.test/token', salesforceClientId: 'id', salesforceClientSecret: 'secret',
    salesforceRequest: { async post() { requests += 1; throw new Error('não deveria chamar'); } }
  });
  await request(app).post('/api/customer/events').send(openPayload());
  const accepted = await request(app).post('/api/agent/conversations/session-test-1/accept').send();
  assert.equal(accepted.status, 503);
  assert.equal(requests, 0);
});

test('anexo recebido é guardado em memória sem expor Base64 na API', async () => {
  const app = createApp();
  await request(app).post('/api/customer/events').send(openPayload());
  const uploaded = await request(app).post('/api/customer/events').send({
    action: 'SEND_FILE', identifier: 'session-test-1',
    parameters: { file: { name: 'imagem.png', contentType: 'image/png', file: 'iVBORw0KGgo=', caption: 'Imagem recebida' } }
  });
  const conversation = (await request(app).get('/api/agent/conversations/session-test-1')).body;
  const internalFile = app.locals.store.get('session-test-1').messages.at(-1).file;
  const fileView = conversation.messages.at(-1).file;
  assert.equal(uploaded.status, 200);
  assert.equal(fileView.name, 'imagem.png');
  assert.equal('contentBase64' in fileView, false);
  assert.equal('previewDataUrl' in fileView, false);
  assert.match(fileView.previewUrl, /^\/api\/agent\/conversations\/session-test-1\/files\//);
  assert.equal(internalFile.contentBase64, 'iVBORw0KGgo=');
  const preview = await request(app).get(fileView.previewUrl);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['x-content-type-options'], 'nosniff');
  assert.equal(Buffer.from(preview.body).toString('base64'), 'iVBORw0KGgo=');
});

test('Base64 malformado é rejeitado', async () => {
  const app = createApp();
  await request(app).post('/api/customer/events').send(openPayload());
  const response = await request(app).post('/api/customer/events').send({
    action: 'SEND_FILE', identifier: 'session-test-1',
    parameters: { file: { name: 'arquivo.bin', contentType: 'application/octet-stream', file: 'A=' } }
  });
  assert.equal(response.status, 400);
});

test('disponibilidade compartilhada bloqueia o aceite enquanto offline', async () => {
  const app = createApp();
  await request(app).post('/api/customer/events').send(openPayload());
  const offline = await request(app).put('/api/agent/status').send({ available: false });
  const rejected = await request(app).post('/api/agent/conversations/session-test-1/accept').send();
  const currentStatus = await request(app).get('/api/agent/status');
  assert.equal(offline.body.available, false);
  assert.equal(rejected.status, 409);
  assert.equal(currentStatus.body.available, false);

  const activeApp = createApp();
  await request(activeApp).post('/api/customer/events').send(openPayload());
  await request(activeApp).post('/api/agent/conversations/session-test-1/accept').send();
  await request(activeApp).put('/api/agent/status').send({ available: false });
  const blockedMessage = await request(activeApp).post('/api/agent/conversations/session-test-1/messages').send({ message: 'Teste offline' });
  assert.equal(blockedMessage.status, 409);
});

test('APIs administrativas e eventos externos exigem chaves independentes', async () => {
  const app = createApp({ adminToken: 'admin-test-key', inboundApiKey: 'inbound-test-key' });
  const privateDataDenied = await request(app).get('/api/agent/conversations');
  const adminLogin = await request(app).post('/api/auth/check').set('X-Admin-Token', 'admin-test-key').send({});
  const privateDataAllowed = await request(app).get('/api/agent/conversations').set('X-Admin-Token', 'admin-test-key');
  const inboundDenied = await request(app).post('/api/customer/events').send(openPayload());
  const inboundAllowed = await request(app).post('/api/customer/events').set('X-Inbound-Api-Key', 'inbound-test-key').send(openPayload());
  assert.equal(privateDataDenied.status, 401);
  assert.equal(adminLogin.status, 200);
  assert.equal(privateDataAllowed.status, 200);
  assert.equal(inboundDenied.status, 401);
  assert.equal(inboundAllowed.status, 200);
});

test('bind em rede exige token administrativo e chave de entrada', () => {
  const secureNetworkSettings = { adminToken: 'admin', inboundApiKey: 'inbound', trustProxy: true };
  assert.throws(() => validateNetworkSettings('0.0.0.0', { adminToken: '', inboundApiKey: '' }), /ADMIN_TOKEN, INBOUND_API_KEY e TRUST_PROXY/);
  assert.doesNotThrow(() => validateNetworkSettings('0.0.0.0', secureNetworkSettings));
  assert.throws(() => validateNetworkSettings('0.0.0.0', { ...secureNetworkSettings, corsOrigin: 'http://poc.example.test' }), /somente origens HTTPS/);
  assert.doesNotThrow(() => validateNetworkSettings('127.0.0.1', { adminToken: '', inboundApiKey: '' }));
});

test('acesso administrativo e eventos de rede exigem HTTPS', async () => {
  const app = createApp({ adminToken: 'admin-key', inboundApiKey: 'inbound-key', publicNetwork: true, trustProxy: true });
  const insecureLogin = await request(app).post('/api/auth/check').set('X-Admin-Token', 'admin-key').send({});
  const secureLogin = await request(app).post('/api/auth/check').set('X-Forwarded-Proto', 'https').set('X-Admin-Token', 'admin-key').send({});
  const insecureEvent = await request(app).post('/api/customer/events').set('X-Inbound-Api-Key', 'inbound-key').send(openPayload());
  const secureEvent = await request(app).post('/api/customer/events').set('X-Forwarded-Proto', 'https').set('X-Inbound-Api-Key', 'inbound-key').send(openPayload());
  assert.equal(insecureLogin.status, 400);
  assert.equal(secureLogin.status, 200);
  assert.equal(insecureEvent.status, 400);
  assert.equal(secureEvent.status, 200);
});

test('origem HTTPS própria funciona sem CORS_ORIGIN fixo', async () => {
  const app = createApp({ adminToken: 'admin-key', inboundApiKey: 'inbound-key', publicNetwork: true, trustProxy: true });
  const response = await request(app).get('/api/agent/status')
    .set('Host', 'poc.example.test').set('Origin', 'https://poc.example.test')
    .set('X-Forwarded-Proto', 'https').set('X-Admin-Token', 'admin-key');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'https://poc.example.test');
});

test('configuração Salesforce é protegida e não devolve segredos', async () => {
  const app = createApp({
    adminToken: 'admin-test-key',
    salesforceRequest: { async post() { return { data: { access_token: 'oauth-secret-token', expires_in: 3600 } }; } }
  });
  const denied = await request(app).get('/api/admin/salesforce/config');
  const saved = await request(app).put('/api/admin/salesforce/config').set('X-Admin-Token', 'admin-test-key').send({
    callbackMode: 'http', tokenUrl: 'https://test.salesforce.com/services/oauth2/token',
    webhookUrl: 'https://org.example.test/services/apexrest/BettaWebhookCallback',
    clientId: 'client-id-test', clientSecret: 'client-secret-test'
  });
  const config = await request(app).get('/api/admin/salesforce/config').set('X-Admin-Token', 'admin-test-key');
  const tested = await request(app).post('/api/admin/salesforce/test').set('X-Admin-Token', 'admin-test-key').send({});
  assert.equal(denied.status, 401);
  assert.equal(saved.body.persistent, true);
  assert.equal(config.body.clientSecretConfigured, true);
  assert.equal('clientSecret' in config.body, false);
  assert.equal(tested.body.connected, true);
  assert.equal('access_token' in tested.body, false);
});

test('WebSocket administrativo autentica antes de confirmar conexão', async () => {
  const instance = createServer({ adminToken: 'admin-test-key' });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const connected = new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({ event: 'AUTH', data: { token: 'admin-test-key' } })));
    socket.once('message', (message) => resolve(JSON.parse(message.toString())));
    socket.once('error', reject);
  });
  const event = await connected;
  assert.equal(event.event, 'CONNECTED');
  socket.close();
  await new Promise((resolve) => instance.webSocketServer.close(() => instance.server.close(resolve)));
});

test('WebSocket de rede rejeita HTTP durante handshake antes da autenticação', async () => {
  const instance = createServer({
    adminToken: 'admin-test-key', inboundApiKey: 'inbound-test-key',
    publicNetwork: true, trustProxy: true
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const error = await new Promise((resolve) => socket.once('error', resolve));
  assert.match(error.message, /Unexpected server response: 400/);
  await new Promise((resolve) => instance.webSocketServer.close(() => instance.server.close(resolve)));
});

test('WebSocket aceita a própria origem HTTPS dinâmica com proxy confiável', async () => {
  const instance = createServer({ adminToken: 'admin-test-key', inboundApiKey: 'inbound-test-key', publicNetwork: true, trustProxy: true });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  const origin = `https://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { Origin: origin, 'X-Forwarded-Proto': 'https' } });
  const connected = new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({ event: 'AUTH', data: { token: 'admin-test-key' } })));
    socket.once('message', (message) => resolve(JSON.parse(message.toString())));
    socket.once('error', reject);
  });
  assert.equal((await connected).event, 'CONNECTED');
  socket.close();
  await new Promise((resolve) => instance.webSocketServer.close(() => instance.server.close(resolve)));
});

test('valida ação e payload inválido sem derrubar o servidor', async () => {
  const app = createApp();
  const missing = await request(app).post('/api/customer/events').send({ action: 'OPEN_CONVERSATION' });
  const unknown = await request(app).post('/api/customer/events').send({ action: 'UNKNOWN', identifier: 'x' });
  const absent = await request(app).post('/api/customer/events').send({ action: 'SEND_MESSAGE', identifier: 'missing', parameters: { messages: ['Oi'] } });
  assert.equal(missing.status, 400);
  assert.equal(unknown.status, 400);
  assert.equal(absent.status, 404);
});