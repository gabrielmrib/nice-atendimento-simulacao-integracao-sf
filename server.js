require('dotenv').config();

const axios = require('axios');
const cors = require('cors');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const publicDirectory = path.join(__dirname, 'public');
const safeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function getAllowedOrigins(settings = {}) {
  const port = process.env.PORT || '433';
  return (settings.corsOrigin || process.env.CORS_ORIGIN || `http://localhost:${port},http://127.0.0.1:${port}`)
    .split(',').map((origin) => origin.trim()).filter(Boolean);
}

function isLoopbackHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(host || '').toLowerCase());
}

function getRequestOrigin(req, trustProxy) {
  const forwardedProtocol = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const protocol = req.socket.encrypted || forwardedProtocol === 'https' ? 'https' : 'http';
  return `${protocol}://${req.headers.host}`;
}

function matchesSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isHttpsUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch (error) { return false; }
}

function validateNetworkSettings(host, settings) {
  if (!isLoopbackHost(host) && (!settings.adminToken || !settings.inboundApiKey || !settings.trustProxy)) {
    throw new Error('Para escutar fora de localhost, configure ADMIN_TOKEN, INBOUND_API_KEY e TRUST_PROXY=true.');
  }
  if (!isLoopbackHost(host) && settings.corsOrigin && settings.corsOrigin.split(',').some((origin) => {
    return !isHttpsUrl(origin.trim());
  })) {
    throw new Error('CORS_ORIGIN em bind de rede deve conter somente origens HTTPS válidas.');
  }
  if (settings.callbackMode === 'http' && (!isHttpsUrl(settings.salesforceTokenUrl) || !isHttpsUrl(settings.webhookUrl))) {
    throw new Error('CALLBACK_MODE=http exige SALESFORCE_TOKEN_URL e SALESFORCE_WEBHOOK_URL com HTTPS.');
  }
}

function getSettings(overrides = {}) {
  return {
    callbackMode: overrides.callbackMode || (process.env.CALLBACK_MODE === 'http' ? 'http' : 'mock'),
    webhookUrl: overrides.webhookUrl ?? process.env.SALESFORCE_WEBHOOK_URL ?? '',
    salesforceTokenUrl: overrides.salesforceTokenUrl ?? process.env.SALESFORCE_TOKEN_URL ?? 'https://login.salesforce.com/services/oauth2/token',
    salesforceClientId: overrides.salesforceClientId ?? process.env.SALESFORCE_CLIENT_ID ?? '',
    salesforceClientSecret: overrides.salesforceClientSecret ?? process.env.SALESFORCE_CLIENT_SECRET ?? '',
    adminToken: overrides.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    inboundApiKey: overrides.inboundApiKey ?? process.env.INBOUND_API_KEY ?? '',
    corsOrigin: overrides.corsOrigin ?? process.env.CORS_ORIGIN ?? '',
    publicNetwork: overrides.publicNetwork ?? !isLoopbackHost(process.env.HOST || '127.0.0.1'),
    trustProxy: overrides.trustProxy ?? process.env.TRUST_PROXY === 'true',
    callbackTimeoutMs: Number(overrides.callbackTimeoutMs ?? process.env.CALLBACK_TIMEOUT_MS ?? 5000),
    maxFileSizeBytes: Number(overrides.maxFileSizeBytes ?? process.env.MAX_FILE_SIZE_BYTES ?? 1048576),
    oauthClientId: overrides.oauthClientId ?? process.env.OAUTH_CLIENT_ID ?? 'demo-client',
    oauthClientSecret: overrides.oauthClientSecret ?? process.env.OAUTH_CLIENT_SECRET ?? 'demo-secret',
    agentId: String(overrides.agentId ?? process.env.AGENT_ID ?? '9942'),
    agentName: overrides.agentName ?? process.env.AGENT_NAME ?? 'Atendente de demonstração',
    callbackSender: overrides.callbackSender,
    salesforceRequest: overrides.salesforceRequest || axios
  };
}

function messageText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message)) {
    return message.map((item) => messageText(item?.default || item)).filter(Boolean).join('\n');
  }
  if (message.default) return messageText(message.default);
  return '';
}

function historyMessage(item) {
  const text = messageText(item?.message ?? item?.text);
  return {
    id: String(item?.id || randomUUID()),
    sender: ['user', 'bot', 'agent'].includes(item?.sender) ? item.sender : 'bot',
    text,
    time: item?.time || new Date().toISOString(),
    delivery: 'received'
  };
}

function publicConversation(conversation) {
  return {
    ...conversation,
    messages: conversation.messages.map(({ file, ...message }) => ({
      ...message,
      ...(file ? {
        file: {
          name: file.name,
          contentType: file.contentType,
          caption: file.caption,
          size: file.size,
          ...(safeImageTypes.has(file.contentType) && file.contentBase64 ? {
            previewUrl: `/api/agent/conversations/${encodeURIComponent(conversation.identifier)}/files/${encodeURIComponent(message.id)}`
          } : {})
        }
      } : {})
    }))
  };
}

function createApp(overrides = {}) {
  const settings = getSettings(overrides);
  const store = overrides.store || new Map();
  const integrationConfigKey = '__integration_config__';
  const agentStatusKey = '__agent_status__';
  let tokenCache = null;
  let agentAvailable = true;
  const app = express();

  app.locals.store = store;
  app.locals.broadcast = () => {};
  app.locals.settings = settings;
  app.set('trust proxy', settings.trustProxy ? 1 : false);

  function adminAuth(req, res, next) {
    if (!settings.adminToken || matchesSecret(req.get('x-admin-token'), settings.adminToken)) return next();
    return res.status(401).json({ error: 'Acesso administrativo necessário.' });
  }

  function requireHttpsForNetworkAdmin(req, res, next) {
    if (settings.publicNetwork && !req.secure) return res.status(400).json({ error: 'A administração exige HTTPS. Configure TLS no load balancer/proxy.' });
    return next();
  }

  function inboundAuth(req, res, next) {
    if (settings.publicNetwork && !req.secure) return res.status(400).json({ error: 'Eventos externos exigem HTTPS.' });
    if (!settings.inboundApiKey || matchesSecret(req.get('x-inbound-api-key'), settings.inboundApiKey)) return next();
    return res.status(401).json({ error: 'Chave de integração inválida.' });
  }

  const allowedOrigins = getAllowedOrigins(settings);
  app.use((req, res, next) => cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || origin === getRequestOrigin(req, settings.trustProxy)) return callback(null, true);
      return callback(null, false);
    }
  })(req, res, next));
  app.use(express.json({ limit: process.env.MAX_JSON_BODY || '2mb' }));
  app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
  app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));
  if (overrides.serveStatic !== false) app.use(express.static(publicDirectory));
  app.use('/api', async (req, res, next) => {
    try {
      const savedConfig = await store.get(integrationConfigKey);
      if (savedConfig) {
        const keys = ['callbackMode', 'webhookUrl', 'salesforceTokenUrl', 'salesforceClientId', 'salesforceClientSecret'];
        const changed = keys.some((key) => savedConfig[key] !== undefined && savedConfig[key] !== settings[key]);
        for (const key of ['callbackMode', 'webhookUrl', 'salesforceTokenUrl', 'salesforceClientId', 'salesforceClientSecret']) {
          if (savedConfig[key] !== undefined) settings[key] = savedConfig[key];
        }
        if (changed) tokenCache = null;
      }
      const savedAgentStatus = await store.get(agentStatusKey);
      if (savedAgentStatus) agentAvailable = savedAgentStatus.available;
      return next();
    } catch (error) { return next(error); }
  });
  app.use(['/api/agent', '/api/demo', '/api/admin', '/api/Agent/1.0/token', '/api/NiceConversations/1.0/token'], adminAuth, requireHttpsForNetworkAdmin);
  app.use(['/api/customer/events', '/eventsLegacy'], inboundAuth);

  async function listConversations() {
    if (typeof store.listConversations === 'function') return store.listConversations();
    return [...store.values()].filter((item) => !item._system);
  }

  async function clearConversations() {
    if (typeof store.clearConversations === 'function') return store.clearConversations();
    for (const [key, value] of store.entries()) {
      if (!value?._system) store.delete(key);
    }
  }

  function publish(event, conversation) {
    app.locals.broadcast(event, publicConversation(conversation));
  }

  async function sendCallback(payload) {
    if (settings.callbackMode === 'mock') {
      return { delivery: 'simulated', message: 'Simulado localmente; nenhum callback externo foi enviado.' };
    }
    if (!settings.webhookUrl) {
      const error = new Error('Configure SALESFORCE_WEBHOOK_URL para usar o modo HTTP.');
      error.status = 503;
      throw error;
    }
    if (!isHttpsUrl(settings.webhookUrl)) {
      const error = new Error('SALESFORCE_WEBHOOK_URL deve usar HTTPS.');
      error.status = 503;
      throw error;
    }
    try {
      if (settings.callbackSender) {
        await settings.callbackSender(payload);
      } else {
        const accessToken = await getSalesforceAccessToken();
        await settings.salesforceRequest.post(settings.webhookUrl, payload, {
          timeout: settings.callbackTimeoutMs,
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      }
    } catch (cause) {
      const error = new Error('Falha na entrega ao webhook Salesforce.');
      error.status = cause.status === 503 ? 503 : 502;
      error.cause = cause;
      throw error;
    }
    return { delivery: 'delivered', message: 'Callback aceito pelo endpoint configurado.' };
  }

  async function getSalesforceAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.accessToken;
    if (!isHttpsUrl(settings.salesforceTokenUrl)) {
      const error = new Error('SALESFORCE_TOKEN_URL deve usar HTTPS.');
      error.status = 503;
      throw error;
    }
    if (!settings.salesforceTokenUrl || !settings.salesforceClientId || !settings.salesforceClientSecret) {
      const error = new Error('Configure SALESFORCE_TOKEN_URL, SALESFORCE_CLIENT_ID e SALESFORCE_CLIENT_SECRET.');
      error.status = 503;
      throw error;
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: settings.salesforceClientId,
      client_secret: settings.salesforceClientSecret
    });
    try {
      const response = await settings.salesforceRequest.post(settings.salesforceTokenUrl, form.toString(), {
        timeout: settings.callbackTimeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (!response.data?.access_token) throw new Error('Token OAuth ausente na resposta.');
      tokenCache = {
        accessToken: response.data.access_token,
        expiresAt: Date.now() + Number(response.data.expires_in || 3600) * 1000
      };
      return tokenCache.accessToken;
    } catch (cause) {
      const error = new Error('Não foi possível autenticar no Salesforce. Verifique a Connected App e as credenciais.');
      error.status = 502;
      error.cause = cause;
      throw error;
    }
  }

  function responseFor(conversation, delivery) {
    return { conversation: publicConversation(conversation), delivery };
  }

  function notFound(identifier) {
    const error = new Error(`Conversa não encontrada: ${identifier}`);
    error.status = 404;
    return error;
  }

  async function ingestEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
      const error = new Error('Informe uma ação válida no campo action.');
      error.status = 400;
      throw error;
    }

    const identifier = String(body.identifier || '').trim();
    if (!identifier) {
      const error = new Error('O campo identifier é obrigatório.');
      error.status = 400;
      throw error;
    }
    if (!['OPEN_CONVERSATION', 'SEND_MESSAGE', 'UPLOAD_FILE', 'SEND_FILE', 'CLOSE_CONVERSATION'].includes(body.action)) {
      const error = new Error(`Ação não suportada: ${body.action}`);
      error.status = 400;
      throw error;
    }

    if (body.action === 'OPEN_CONVERSATION') {
      const existing = await store.get(identifier);
      if (existing) return existing;

      const parameters = body.parameters || {};
      const contact = parameters.contact || {};
      const conversation = {
        identifier,
        conversationId: String(body.conversationId || identifier),
        requestId: body.requestId || null,
        skillId: body.skillId || null,
        queueNice: body.QueueNice || parameters.QueueNice || null,
        status: 'QUEUED',
        agent: null,
        contact: {
          id: contact.id ?? null,
          name: contact.name || 'Cliente sem nome',
          email: contact.email || '',
          phone: contact.phone || '',
          cpf: contact.cpf || '',
          channel: contact.channel || 'mensagem',
          extra: contact.extra || {}
        },
        extraInfo: parameters.extraInfo || {},
        messages: Array.isArray(contact.history) ? contact.history.map(historyMessage) : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await store.set(identifier, conversation);
      publish('NEW_QUEUED_CONVERSATION', conversation);
      return conversation;
    }

    const conversation = await store.get(identifier);
    if (!conversation) throw notFound(identifier);

    if (body.action === 'SEND_MESSAGE') {
      if (conversation.status === 'CLOSED') {
        const error = new Error('A conversa está encerrada.');
        error.status = 409;
        throw error;
      }
      const incoming = body.parameters?.messages;
      const messages = Array.isArray(incoming) ? incoming : typeof incoming === 'string' ? [incoming] : [];
      if (!messages.length || messages.some((text) => typeof text !== 'string' || !text.trim())) {
        const error = new Error('parameters.messages deve conter ao menos uma mensagem de texto.');
        error.status = 400;
        throw error;
      }
      for (const text of messages) {
        conversation.messages.push({ id: randomUUID(), sender: 'user', text, time: new Date().toISOString(), delivery: 'received' });
      }
      conversation.updatedAt = new Date().toISOString();
      await store.set(identifier, conversation);
      publish('CONVERSATION_UPDATED', conversation);
      return conversation;
    }

    if (body.action === 'UPLOAD_FILE' || body.action === 'SEND_FILE') {
      if (conversation.status === 'CLOSED') {
        const error = new Error('A conversa está encerrada.');
        error.status = 409;
        throw error;
      }
      const source = body.parameters?.file || body.file;
      if (!source || typeof source !== 'object' || typeof source.name !== 'string') {
        const error = new Error('Informe file com name, contentType e conteúdo Base64.');
        error.status = 400;
        throw error;
      }
      const contentType = String(source.contentType || 'application/octet-stream').toLowerCase();
      const encoded = String(source.file || source.base64 || '').replace(/^data:[^,]+;base64,/, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        const error = new Error('O conteúdo do arquivo deve estar codificado em Base64 válido.');
        error.status = 400;
        throw error;
      }
      const decoded = Buffer.from(encoded, 'base64');
      const size = decoded.length;
      if (!size || decoded.toString('base64') !== encoded) {
        const error = new Error('O conteúdo do arquivo deve estar codificado em Base64 válido.');
        error.status = 400;
        throw error;
      }
      if (size > settings.maxFileSizeBytes) {
        const error = new Error(`Arquivo acima do limite de ${settings.maxFileSizeBytes} bytes.`);
        error.status = 413;
        throw error;
      }
      const file = {
        name: path.basename(source.name).slice(0, 180),
        contentType,
        caption: String(source.caption || '').slice(0, 500),
        size,
        contentBase64: encoded
      };
      if (safeImageTypes.has(contentType)) file.previewDataUrl = `data:${contentType};base64,${encoded}`;
      conversation.messages.push({
        id: randomUUID(), sender: 'user', text: file.caption || `Arquivo recebido: ${file.name}`,
        time: new Date().toISOString(), delivery: 'received', file
      });
      conversation.updatedAt = new Date().toISOString();
      await store.set(identifier, conversation);
      publish('CONVERSATION_UPDATED', conversation);
      return conversation;
    }

    if (body.action === 'CLOSE_CONVERSATION') {
      if (conversation.status !== 'CLOSED') {
        conversation.status = 'CLOSED';
        conversation.updatedAt = new Date().toISOString();
        await store.set(identifier, conversation);
        publish('CONVERSATION_CLOSED', conversation);
      }
      return conversation;
    }

    const error = new Error(`Ação não suportada: ${body.action}`);
    error.status = 400;
    throw error;
  }

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/config', (req, res) => res.json({
    callbackMode: settings.callbackMode,
    authRequired: Boolean(settings.adminToken),
    httpsRequired: settings.publicNetwork,
    agentAvailable,
    agent: { id: settings.agentId, name: settings.agentName }
  }));
  app.post('/api/auth/check', (req, res) => {
    if (settings.publicNetwork && !req.secure) return res.status(400).json({ error: 'O acesso administrativo exige HTTPS.' });
    if (!settings.adminToken || matchesSecret(req.get('x-admin-token'), settings.adminToken)) return res.json({ authenticated: true });
    return res.status(401).json({ error: 'Chave administrativa inválida.' });
  });
  app.get('/api/agent/status', (req, res) => res.json({ available: agentAvailable }));
  app.put('/api/agent/status', async (req, res, next) => {
    if (typeof req.body?.available !== 'boolean') return res.status(400).json({ error: 'Informe available como booleano.' });
    try {
      agentAvailable = req.body.available;
      await store.set(agentStatusKey, { _system: true, available: agentAvailable });
      app.locals.broadcast('AGENT_STATUS_UPDATED', { available: agentAvailable });
      return res.json({ available: agentAvailable });
    } catch (error) { return next(error); }
  });
  app.get('/api/agent/conversations', async (req, res, next) => {
    try { return res.json((await listConversations()).map(publicConversation)); }
    catch (error) { return next(error); }
  });
  app.get('/api/agent/conversations/:identifier', async (req, res, next) => {
    try {
      const conversation = await store.get(req.params.identifier);
      if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
      return res.json(publicConversation(conversation));
    } catch (error) { return next(error); }
  });
  app.get('/api/agent/conversations/:identifier/files/:messageId', async (req, res, next) => {
    try {
      const conversation = await store.get(req.params.identifier);
      const message = conversation?.messages.find((item) => item.id === req.params.messageId);
      if (!message?.file || !safeImageTypes.has(message.file.contentType) || !message.file.contentBase64) {
        return res.status(404).json({ error: 'Prévia não encontrada.' });
      }
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, no-store');
      return res.type(message.file.contentType).send(Buffer.from(message.file.contentBase64, 'base64'));
    } catch (error) { return next(error); }
  });

  app.post(['/api/Agent/1.0/token', '/api/NiceConversations/1.0/token'], (req, res) => {
    const body = req.body || {};
    if (body.grant_type !== 'client_credentials' || body.client_id !== settings.oauthClientId || body.client_secret !== settings.oauthClientSecret) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Credenciais inválidas.' });
    }
    return res.json({ access_token: 'mocked_bearer_token', token_type: 'Bearer', expires_in: 3600, scope: 'admin' });
  });

  const customerEventHandler = async (req, res, next) => {
    try {
      const conversation = await ingestEvent(req.body);
      return res.json({ requestId: req.body.requestId || null, message: 'OK' });
    } catch (error) {
      return next(error);
    }
  };
  app.post(['/api/customer/events', '/eventsLegacy'], customerEventHandler);

  app.post('/api/demo/seed', (req, res) => {
    const identifier = `demo-${randomUUID()}`;
    const timestamp = Date.now();
    const body = {
      action: 'OPEN_CONVERSATION', identifier, conversationId: `conv-${identifier}`, requestId: `req-${identifier}`,
      skillId: '35629200', QueueNice: 'SEGURO', timestamp,
      parameters: {
        contact: {
          id: timestamp, channel: 'whatsapp', name: ['Marina Costa', 'Rafael Almeida', 'Camila Souza'][Math.floor(Math.random() * 3)],
          email: 'cliente@example.test', phone: '11900000000', cpf: '00000000000', extra: {},
          history: [
            { sender: 'user', time: new Date(timestamp - 60000).toISOString(), message: { text: 'Olá, preciso de ajuda com meu atendimento.' } },
            { sender: 'bot', time: new Date(timestamp - 45000).toISOString(), message: [{ default: { text: 'Claro! Vou direcionar você para uma pessoa especialista.', type: 'text' } }] }
          ]
        },
        extraInfo: { CPF: '00000000000', Fila: 'FILA_DEMO', Nome: 'Cliente de demonstração', 'E-mail': 'cliente@example.test', Telefone: '11900000000', instancia: 'simulador-local', contact_id: timestamp, CanalOperacao: 'porto_cartoes', tipodeservico: 'Atendimento_Humano' }
      }
    };
    ingestEvent(body).then((conversation) => res.status(201).json(publicConversation(conversation))).catch((error) => res.status(error.status || 500).json({ error: error.message }));
  });

  app.post('/api/demo/reset', async (req, res, next) => {
    try {
      await clearConversations();
      app.locals.broadcast('SNAPSHOT_RESET', {});
      return res.json({ message: 'Conversas locais removidas.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/demo/incoming', async (req, res) => {
    try {
      const conversation = await ingestEvent(req.body);
      return res.json({ requestId: req.body.requestId || null, message: 'OK', conversation: publicConversation(conversation) });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Falha ao simular evento.' });
    }
  });

  app.get('/api/admin/salesforce/config', (req, res) => res.json({
    callbackMode: settings.callbackMode,
    tokenUrl: settings.salesforceTokenUrl,
    webhookUrl: settings.webhookUrl,
    clientId: settings.salesforceClientId,
    clientSecretConfigured: Boolean(settings.salesforceClientSecret)
  }));
  app.put('/api/admin/salesforce/config', (req, res, next) => {
    const body = req.body || {};
    if (!['mock', 'http'].includes(body.callbackMode)) return res.status(400).json({ error: 'Modo de callback inválido.' });
    for (const [label, value] of [['URL de token', body.tokenUrl], ['URL de callback', body.webhookUrl]]) {
      if (value) {
        try {
          if (new URL(value).protocol !== 'https:') throw new Error();
        } catch (error) { return res.status(400).json({ error: `${label} deve usar HTTPS.` }); }
      }
    }
    const nextClientId = String(body.clientId || '');
    const nextClientSecret = body.clientSecret ? String(body.clientSecret) : settings.salesforceClientSecret;
    if (body.callbackMode === 'http' && (!body.webhookUrl || !nextClientId || !nextClientSecret)) {
      return res.status(400).json({ error: 'Modo HTTP exige URL de callback, Client ID e Client Secret.' });
    }
    const nextTokenUrl = body.tokenUrl || settings.salesforceTokenUrl;
    if (body.callbackMode === 'http' && (!isHttpsUrl(nextTokenUrl) || !isHttpsUrl(body.webhookUrl))) {
      return res.status(400).json({ error: 'URLs OAuth e Apex REST devem usar HTTPS.' });
    }
    settings.callbackMode = body.callbackMode;
    if (body.tokenUrl) settings.salesforceTokenUrl = body.tokenUrl;
    settings.webhookUrl = body.webhookUrl || '';
    settings.salesforceClientId = nextClientId;
    settings.salesforceClientSecret = nextClientSecret;
    tokenCache = null;
    const persist = store.set(integrationConfigKey, {
      _system: true,
      callbackMode: settings.callbackMode,
      webhookUrl: settings.webhookUrl,
      salesforceTokenUrl: settings.salesforceTokenUrl,
      salesforceClientId: settings.salesforceClientId,
      salesforceClientSecret: settings.salesforceClientSecret
    });
    return Promise.resolve(persist).then(() => res.json({
      callbackMode: settings.callbackMode,
      tokenUrl: settings.salesforceTokenUrl,
      webhookUrl: settings.webhookUrl,
      clientId: settings.salesforceClientId,
      clientSecretConfigured: Boolean(settings.salesforceClientSecret),
      persistent: true
    })).catch(next);
  });
  app.post('/api/admin/salesforce/test', async (req, res) => {
    try {
      await getSalesforceAccessToken();
      return res.json({ connected: true, message: 'OAuth Salesforce validado. O token não foi enviado ao browser.' });
    } catch (error) {
      return res.status(error.status || 502).json({ error: error.status === 503 ? error.message : 'Falha na autenticação Salesforce. Confira a Connected App, o usuário de integração e o endpoint de token.' });
    }
  });

  async function runAgentAction(req, res, next, action) {
    try {
      const conversation = await store.get(req.params.identifier);
      if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada.' });
      if (action === 'accept') {
        if (!agentAvailable) return res.status(409).json({ error: 'O agente está indisponível para aceitar conversas.' });
        if (conversation.status !== 'QUEUED') return res.status(409).json({ error: 'Esta conversa não está mais disponível para aceite.' });
        conversation.status = 'ACCEPTING';
        await store.set(conversation.identifier, conversation);
        publish('CONVERSATION_UPDATED', conversation);
        const payload = {
          action: 'ACCEPT_CONVERSATION', conversationID: conversation.identifier,
          parameters: { agent: { id: Number(settings.agentId) || settings.agentId, name: settings.agentName } }, timestamp: Date.now()
        };
        try {
          const delivery = await sendCallback(payload);
          conversation.status = 'ACTIVE';
          conversation.agent = { id: settings.agentId, name: settings.agentName };
          conversation.delivery = delivery;
          conversation.updatedAt = new Date().toISOString();
          await store.set(conversation.identifier, conversation);
          publish('CONVERSATION_UPDATED', conversation);
          return res.json(responseFor(conversation, delivery));
        } catch (error) {
          conversation.status = 'QUEUED';
          await store.set(conversation.identifier, conversation);
          publish('CONVERSATION_UPDATED', conversation);
          throw error;
        }
      }

      if (action === 'message') {
        if (!agentAvailable) return res.status(409).json({ error: 'O agente está indisponível para enviar mensagens.' });
        if (conversation.status !== 'ACTIVE') return res.status(409).json({ error: 'Aceite o atendimento antes de responder.' });
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        if (!message) return res.status(400).json({ error: 'A mensagem não pode estar vazia.' });
        const payload = {
          action: 'SEND_MESSAGE', conversationId: conversation.conversationId, identifier: conversation.identifier,
          agentId: settings.agentId, parameters: { agent: { name: settings.agentName }, messages: [message] }, timestamp: Date.now()
        };
        const delivery = await sendCallback(payload);
        conversation.messages.push({ id: randomUUID(), sender: 'agent', text: message, time: new Date().toISOString(), delivery: delivery.delivery });
        conversation.delivery = delivery;
        conversation.updatedAt = new Date().toISOString();
        await store.set(conversation.identifier, conversation);
        publish('CONVERSATION_UPDATED', conversation);
        return res.json(responseFor(conversation, delivery));
      }

      if (action === 'close') {
        if (!['ACTIVE', 'CLOSED'].includes(conversation.status)) return res.status(409).json({ error: 'Só é possível encerrar um atendimento ativo.' });
        if (conversation.status === 'CLOSED') return res.json(responseFor(conversation, conversation.delivery));
        conversation.status = 'CLOSING';
        await store.set(conversation.identifier, conversation);
        publish('CONVERSATION_UPDATED', conversation);
        const payload = {
          action: 'CLOSE_CONVERSATION', conversationId: conversation.conversationId,
          identifier: conversation.identifier, requestId: `req-close-${randomUUID()}`, timestamp: Date.now()
        };
        try {
          const delivery = await sendCallback(payload);
          conversation.status = 'CLOSED';
          conversation.delivery = delivery;
          conversation.updatedAt = new Date().toISOString();
          await store.set(conversation.identifier, conversation);
          publish('CONVERSATION_CLOSED', conversation);
          return res.json(responseFor(conversation, delivery));
        } catch (error) {
          conversation.status = 'ACTIVE';
          await store.set(conversation.identifier, conversation);
          publish('CONVERSATION_UPDATED', conversation);
          throw error;
        }
      }
    } catch (error) {
      return next(error);
    }
  }

  app.post('/api/agent/conversations/:identifier/accept', (req, res, next) => runAgentAction(req, res, next, 'accept'));
  app.post('/api/agent/conversations/:identifier/messages', (req, res, next) => runAgentAction(req, res, next, 'message'));
  app.post('/api/agent/conversations/:identifier/close', (req, res, next) => runAgentAction(req, res, next, 'close'));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(`Erro na requisição: ${error.message}`);
    return res.status(status).json({ error: status >= 500 ? 'Falha ao processar a operação.' : error.message });
  });

  return app;
}

function createServer(overrides = {}) {
  const app = createApp(overrides);
  const server = http.createServer(app);
  const allowedOrigins = getAllowedOrigins(app.locals.settings);
  const webSocketServer = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ origin, req }, done) => {
      const forwardedProtocol = app.locals.settings.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
      if (app.locals.settings.publicNetwork && !req.socket.encrypted && forwardedProtocol !== 'https') return done(false, 400, 'Secure connection required');
      if (origin && !allowedOrigins.includes(origin) && origin !== getRequestOrigin(req, app.locals.settings.trustProxy)) return done(false, 403, 'Origin not allowed');
      return done(true);
    }
  });
  app.locals.broadcast = (event, data) => {
    const serialized = JSON.stringify({ event, data });
    for (const client of webSocketServer.clients) {
      if (client.readyState === WebSocket.OPEN && client.isAuthorized) client.send(serialized);
    }
  };
  webSocketServer.on('connection', (socket, request) => {
    const settings = app.locals.settings;
    let authorized = !settings.adminToken;
    const timeout = setTimeout(() => socket.close(4001, 'Authentication required'), 10000);
    socket.isAuthorized = authorized;
    const sendConnected = () => {
      clearTimeout(timeout);
      socket.isAuthorized = true;
      socket.send(JSON.stringify({ event: 'CONNECTED', data: {} }));
    };
    if (authorized) sendConnected();
    socket.on('message', (message) => {
      if (authorized) return;
      let payload;
      try { payload = JSON.parse(message.toString()); } catch (error) { return socket.close(4002, 'Invalid authentication message'); }
      if (payload.event !== 'AUTH' || !matchesSecret(payload.data?.token, settings.adminToken)) return socket.close(4003, 'Invalid credentials');
      const forwardedProtocol = settings.trustProxy ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
      const secureConnection = request.socket.encrypted || forwardedProtocol === 'https';
      if (settings.publicNetwork && !secureConnection) return socket.close(4004, 'Secure connection required');
      authorized = true;
      sendConnected();
    });
    socket.on('close', () => clearTimeout(timeout));
  });
  return { app, server, webSocketServer };
}

if (require.main === module) {
  const { server, app } = createServer();
  const port = Number(process.env.PORT || 433);
  const host = process.env.HOST || '127.0.0.1';
  try {
    validateNetworkSettings(host, app.locals.settings);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  server.listen(port, host, () => {
    console.log(`Simulador disponível em http://localhost:${port} (callbacks: ${app.locals.settings.callbackMode})`);
  });
}

module.exports = { createApp, createServer, publicConversation, validateNetworkSettings };