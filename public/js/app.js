(() => {
  const state = { conversations: [], selectedIdentifier: null, config: null, available: true, revealPrivate: false, socket: null, reconnectAttempt: 0, adminToken: '' };
  const $ = (selector) => document.querySelector(selector);
  const byId = (id) => document.getElementById(id);
  const closeModal = new bootstrap.Modal(byId('closeModal'));
  const adminAuthModal = new bootstrap.Modal(byId('adminAuthModal'));
  const connectionModal = new bootstrap.Modal(byId('connectionModal'));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function shortName(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatAge(value) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
    return minutes < 1 ? 'agora' : `${minutes} min`;
  }

  function getSelected() { return state.conversations.find((conversation) => conversation.identifier === state.selectedIdentifier); }
  function getExtra(conversation) { return conversation?.extraInfo || {}; }
  function displayValue(value, fallback = 'Não informado') { return value === undefined || value === null || value === '' ? fallback : String(value); }
  function mask(value, visible = 3) { const text = String(value || ''); return text.length <= visible ? '••••' : `${'•'.repeat(Math.max(4, text.length - visible))}${text.slice(-visible)}`; }
  function redactPrivateFields(value) {
    if (Array.isArray(value)) return value.map(redactPrivateFields);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (!state.revealPrivate && /(cpf|phone|telefone)/i.test(key) && item) return [key, mask(item)];
      return [key, redactPrivateFields(item)];
    }));
  }

  async function api(url, options = {}) {
    const { publicRequest, ...fetchOptions } = options;
    const headers = {
      'Content-Type': 'application/json',
      ...(!publicRequest && state.adminToken ? { 'X-Admin-Token': state.adminToken } : {}),
      ...(fetchOptions.headers || {})
    };
    const response = await fetch(url, { ...fetchOptions, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Falha HTTP ${response.status}`);
    return body;
  }

  function showToast(message, type = 'success') {
    const tone = type === 'error' ? 'text-bg-danger' : type === 'info' ? 'text-bg-dark' : 'text-bg-success';
    const toast = document.createElement('div');
    toast.className = `toast align-items-center ${tone} border-0`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `<div class="d-flex"><div class="toast-body">${escapeHtml(message)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Fechar"></button></div>`;
    byId('toastRegion').append(toast);
    const instance = new bootstrap.Toast(toast, { delay: 3500 });
    toast.addEventListener('hidden.bs.toast', () => toast.remove());
    instance.show();
  }

  function setSocketStatus(connected) {
    const status = byId('socketStatus');
    status.classList.toggle('connected', connected);
    status.classList.toggle('disconnected', !connected);
    status.lastElementChild.textContent = connected ? 'Tempo real ativo' : 'Reconectando';
  }

  function connectSocket() {
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    state.socket = socket;
    socket.addEventListener('open', () => {
      if (state.config?.authRequired) socket.send(JSON.stringify({ event: 'AUTH', data: { token: state.adminToken } }));
    });
    socket.addEventListener('message', (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.event === 'CONNECTED') {
          state.reconnectAttempt = 0;
          setSocketStatus(true);
          refresh();
          return;
        }
        if (event.event === 'SNAPSHOT_RESET') state.selectedIdentifier = null;
        if (event.event === 'AGENT_STATUS_UPDATED') {
          state.available = event.data.available;
          renderAgentStatus();
        }
        if (event.event === 'CONVERSATION_UPDATED' || event.event === 'CONVERSATION_CLOSED' || event.event === 'NEW_QUEUED_CONVERSATION') {
          const current = getSelected();
          state.selectedIdentifier = current?.identifier || state.selectedIdentifier;
        }
        refresh();
      } catch (error) { console.warn('Evento WebSocket inválido.'); }
    });
    socket.addEventListener('close', () => {
      setSocketStatus(false);
      const delay = Math.min(1000 * (2 ** state.reconnectAttempt), 12000);
      state.reconnectAttempt += 1;
      window.setTimeout(connectSocket, delay);
    });
    socket.addEventListener('error', () => socket.close());
  }

  async function refresh() {
    try {
      state.conversations = await api('/api/agent/conversations');
      if (state.selectedIdentifier && !state.conversations.some((item) => item.identifier === state.selectedIdentifier)) state.selectedIdentifier = null;
      renderQueue();
      renderConversation();
      renderContext();
    } catch (error) { showToast(error.message, 'error'); }
  }

  function renderQueue() {
    const search = byId('searchInput').value.trim().toLocaleLowerCase('pt-BR');
    const channel = byId('channelFilter').value;
    const waiting = state.conversations.filter((item) => item.status === 'QUEUED');
    const active = state.conversations.filter((item) => item.status === 'ACTIVE');
    const matches = (conversation) => {
      const searchable = `${conversation.contact?.name || ''} ${conversation.queueNice || ''} ${conversation.extraInfo?.CanalOperacao || ''}`.toLocaleLowerCase('pt-BR');
      return searchable.includes(search) && (channel === 'all' || (channel === 'whatsapp' ? conversation.contact?.channel === 'whatsapp' : conversation.contact?.channel !== 'whatsapp'));
    };
    const visible = waiting.filter(matches);
    const visibleActive = active.filter(matches);
    byId('queueCount').textContent = String(waiting.length);
    byId('waitingCount').textContent = String(waiting.length);
    byId('mobileQueueCount').textContent = String(waiting.length);
    byId('activeCount').textContent = String(active.length);
    const renderItem = (conversation, index, isActive) => {
      const name = conversation.contact?.name || 'Cliente sem nome';
      const channelName = conversation.contact?.channel || 'mensagem';
      const operation = conversation.extraInfo?.CanalOperacao || 'Operação não informada';
      const action = isActive ? '<span class="active-indicator"><i class="bi bi-circle-fill"></i> ATIVO</span>' : `<button class="queue-accept" type="button" data-accept="${escapeHtml(conversation.identifier)}" ${state.available ? '' : 'disabled'}><i class="bi bi-headset"></i>Aceitar atendimento</button>`;
      return `<article class="conversation-item ${state.selectedIdentifier === conversation.identifier ? 'selected' : ''}" data-identifier="${escapeHtml(conversation.identifier)}" role="button" tabindex="0">
        <span class="conversation-item-top"><span class="conversation-item-title"><span class="queue-avatar color-${index % 4}">${escapeHtml(shortName(name))}</span><span class="queue-person"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(channelName)}</small></span></span><span class="queue-age">${escapeHtml(formatAge(conversation.createdAt))}</span></span>
        <span class="conversation-item-meta"><span class="channel-tag"><i class="bi bi-whatsapp"></i>${escapeHtml(operation)}</span><span>${escapeHtml(conversation.queueNice || 'Sem fila')}</span></span>${action}
      </article>`;
    };
    byId('queueList').innerHTML = visible.map((conversation, index) => renderItem(conversation, index, false)).join('');
    byId('activeList').innerHTML = visibleActive.map((conversation, index) => renderItem(conversation, index, true)).join('');
    byId('queueEmpty').classList.toggle('visible', visible.length === 0);
  }

  function renderConversation() {
    const conversation = getSelected();
    byId('chatEmpty').classList.toggle('d-none', Boolean(conversation));
    byId('chatContent').classList.toggle('d-none', !conversation);
    if (!conversation) return;
    const name = conversation.contact?.name || 'Cliente sem nome';
    byId('customerAvatar').textContent = shortName(name);
    byId('customerName').textContent = name;
    byId('customerChannel').textContent = conversation.contact?.channel || 'Mensagem';
    byId('customerSession').textContent = `Sessão ${conversation.identifier.slice(-12)}`;
    const stateLabel = { QUEUED: 'Na fila', ACCEPTING: 'Aceitando', ACTIVE: 'Em atendimento', CLOSING: 'Encerrando', CLOSED: 'Encerrada' }[conversation.status] || conversation.status;
    byId('conversationState').textContent = stateLabel;
    byId('conversationState').className = `state-pill ${conversation.status === 'ACTIVE' ? 'active' : conversation.status === 'QUEUED' ? 'queued' : conversation.status === 'CLOSED' ? 'closed' : ''}`;
    byId('acceptButton').classList.toggle('d-none', conversation.status !== 'QUEUED');
    byId('acceptButton').disabled = !state.available;
    const active = conversation.status === 'ACTIVE' && state.available;
    byId('messageInput').disabled = !active;
    byId('sendButton').disabled = !active;
    byId('readOnlyNotice').classList.toggle('d-none', active || conversation.status === 'CLOSED');
    byId('closeButton').disabled = conversation.status !== 'ACTIVE';
    byId('simulateInboundButton').disabled = conversation.status === 'CLOSED';
    const delivery = conversation.delivery;
    byId('deliveryBanner').classList.toggle('d-none', !delivery);
    if (delivery) {
      byId('deliveryBanner').className = `delivery-banner ${delivery.delivery === 'delivered' ? 'http' : ''}`;
      byId('deliveryBanner').textContent = delivery.message;
    }
    byId('messagesList').innerHTML = (conversation.messages || []).map(renderMessage).join('') || '<div class="context-empty">Ainda não há mensagens nesta conversa.</div>';
    byId('messagesList').scrollTop = byId('messagesList').scrollHeight;
  }

  function renderMessage(message) {
    const sender = message.sender === 'agent' ? 'agent' : message.sender === 'bot' ? 'bot' : 'user';
    const senderLabel = sender === 'agent' ? (getSelected()?.agent?.name || 'Você') : sender === 'bot' ? 'Bot' : 'Cliente';
    const file = message.file;
    let fileMarkup = '';
    if (file) {
      const preview = file.previewUrl && /^\/api\/agent\/conversations\/[^/]+\/files\/[^/]+$/.test(file.previewUrl)
        ? `<img src="${escapeHtml(file.previewUrl)}" alt="Prévia de ${escapeHtml(file.name)}">`
        : `<span class="message-file-icon"><i class="bi bi-paperclip"></i></span>`;
      fileMarkup = `<div class="message-file">${preview}<span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.contentType || 'Arquivo')} · ${Math.max(1, Math.round((file.size || 0) / 1024))} KB</small></span></div>`;
    }
    const delivery = message.delivery === 'simulated' ? '<span class="message-delivery">Simulado localmente</span>' : message.delivery === 'delivered' ? '<span class="message-delivery">Enviado</span>' : '';
    return `<article class="message-row ${sender}"><div class="message-meta"><span class="sender-chip">${escapeHtml(senderLabel)}</span><time>${escapeHtml(formatTime(message.time))}</time></div><div class="message-bubble">${escapeHtml(message.text || '')}${fileMarkup}</div>${delivery}</article>`;
  }

  function renderContext() {
    const conversation = getSelected();
    byId('contextEmpty').classList.toggle('d-none', Boolean(conversation));
    byId('contextContent').classList.toggle('d-none', !conversation);
    if (!conversation) return;
    const contact = conversation.contact || {};
    const extra = getExtra(conversation);
    const name = contact.name || 'Cliente sem nome';
    const cpf = contact.cpf || extra.CPF;
    const phone = contact.phone || extra.Telefone;
    byId('contextAvatar').textContent = shortName(name);
    byId('contextName').textContent = name;
    byId('contextChannelText').textContent = contact.channel || 'Canal não informado';
    byId('contextCpf').textContent = state.revealPrivate ? displayValue(cpf) : mask(cpf);
    byId('contextPhone').textContent = state.revealPrivate ? displayValue(phone) : mask(phone);
    byId('contextEmail').textContent = displayValue(contact.email || extra['E-mail']);
    byId('contextOperation').textContent = displayValue(extra.CanalOperacao);
    byId('contextQueue').textContent = displayValue(conversation.queueNice);
    byId('contextSkill').textContent = displayValue(conversation.skillId);
    byId('contextInstance').textContent = displayValue(extra.instancia);
    byId('contextIdentifier').textContent = conversation.identifier;
    byId('contextExtra').textContent = JSON.stringify(redactPrivateFields(extra), null, 2);
    byId('privacyToggle').textContent = state.revealPrivate ? 'Ocultar' : 'Revelar';
    byId('privacyToggle').setAttribute('aria-pressed', String(state.revealPrivate));
  }

  function renderAgentStatus() {
    byId('agentStatusButton').classList.toggle('offline', !state.available);
    byId('agentStatusButton').setAttribute('aria-pressed', String(state.available));
    byId('agentStatusText').textContent = state.available ? 'Disponível' : 'Indisponível';
    renderQueue();
    renderConversation();
  }

  async function simulateConversation() {
    try {
      const conversation = await api('/api/demo/seed', { method: 'POST', body: '{}' });
      state.selectedIdentifier = conversation.identifier;
      await refresh();
      setMobilePanel('chatPanel');
      showToast('Conversa de demonstração criada.');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function acceptConversation(identifier) {
    try {
      const result = await api(`/api/agent/conversations/${encodeURIComponent(identifier)}/accept`, { method: 'POST', body: '{}' });
      state.selectedIdentifier = identifier;
      await refresh();
      showToast(result.delivery?.message || 'Atendimento aceito.');
      setMobilePanel('chatPanel');
    } catch (error) { showToast(error.message, 'error'); await refresh(); }
  }

  function setMobilePanel(panelId) {
    if (window.matchMedia('(min-width: 992px)').matches) return;
    document.querySelectorAll('.workspace-panel').forEach((panel) => panel.classList.toggle('mobile-hidden', panel.id !== panelId));
    document.querySelectorAll('.mobile-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelId));
  }

  async function sendMessage(event) {
    event.preventDefault();
    const conversation = getSelected();
    const input = byId('messageInput');
    const message = input.value.trim();
    if (!conversation || !message) return;
    byId('sendButton').disabled = true;
    try {
      const result = await api(`/api/agent/conversations/${encodeURIComponent(conversation.identifier)}/messages`, { method: 'POST', body: JSON.stringify({ message }) });
      input.value = '';
      await refresh();
      if (result.delivery?.delivery === 'simulated') showToast('Mensagem registrada na simulação local.');
    } catch (error) { showToast(error.message, 'error'); }
    finally { renderConversation(); }
  }

  async function simulateIncoming() {
    const conversation = getSelected();
    if (!conversation) return;
    const sampleMessages = ['Pode me ajudar com essa solicitação?', 'Consegui localizar o número do pedido.'];
    const text = sampleMessages[Math.floor(Math.random() * sampleMessages.length)];
    try {
      await api('/api/demo/incoming', {
        method: 'POST',
        body: JSON.stringify({ action: 'SEND_MESSAGE', conversationId: conversation.conversationId, identifier: conversation.identifier, requestId: `demo-${Date.now()}`, parameters: { contact: { name: conversation.contact.name, channel: conversation.contact.channel }, messages: [text] }, timestamp: Date.now() })
      });
      await refresh();
      showToast('Mensagem de cliente recebida pelo endpoint de eventos.', 'info');
    } catch (error) { showToast(error.message, 'error'); }
  }

  async function closeConversation() {
    const conversation = getSelected();
    if (!conversation) return;
    byId('confirmCloseButton').disabled = true;
    try {
      const result = await api(`/api/agent/conversations/${encodeURIComponent(conversation.identifier)}/close`, { method: 'POST', body: '{}' });
      closeModal.hide();
      await refresh();
      showToast(result.delivery?.message || 'Atendimento encerrado.');
    } catch (error) { showToast(error.message, 'error'); }
    finally { byId('confirmCloseButton').disabled = false; }
  }

  async function loadConsole() {
    state.available = state.config.agentAvailable;
    renderAgentStatus();
    const badge = byId('modeBadge');
    const mobileBadge = byId('mobileModeBadge');
    if (state.config.callbackMode === 'http') {
      badge.classList.add('http');
      mobileBadge.classList.add('http');
      badge.innerHTML = '<span class="mode-dot"></span> Webhook Salesforce';
      mobileBadge.innerHTML = '<span class="mode-dot"></span> Webhook Salesforce';
    } else {
      badge.classList.remove('http');
      mobileBadge.classList.remove('http');
      badge.innerHTML = '<span class="mode-dot"></span> Simulado local';
      mobileBadge.innerHTML = '<span class="mode-dot"></span> Simulado local';
    }
    state.conversations = await api('/api/agent/conversations');
    renderQueue(); renderConversation(); renderContext();
    setMobilePanel('chatPanel');
    connectSocket();
  }

  async function initialize() {
    try {
      state.config = await api('/api/config', { publicRequest: true });
      if (state.config.authRequired) {
        adminAuthModal.show();
        if (state.config.httpsRequired && location.protocol !== 'https:') {
          byId('adminAuthSubmit').disabled = true;
          byId('adminAuthError').textContent = 'Abra a URL HTTPS publicada pelo load balancer antes de informar a chave.';
          byId('adminAuthError').classList.add('d-block');
        }
        return;
      }
      await loadConsole();
    } catch (error) {
      byId('modeBadge').textContent = 'Servidor indisponível';
      setSocketStatus(false);
      showToast(`Não foi possível carregar o simulador: ${error.message}`, 'error');
    }
  }

  async function authenticateAdmin(event) {
    event.preventDefault();
    if (state.config?.httpsRequired && location.protocol !== 'https:') {
      byId('adminAuthError').textContent = 'Abra a URL HTTPS publicada pelo load balancer antes de informar a chave.';
      byId('adminAuthError').classList.add('d-block');
      return;
    }
    const submit = byId('adminAuthSubmit');
    const token = byId('adminTokenInput').value;
    submit.disabled = true;
    byId('adminAuthError').classList.remove('d-block');
    try {
      await api('/api/auth/check', { method: 'POST', publicRequest: true, headers: { 'X-Admin-Token': token }, body: '{}' });
      state.adminToken = token;
      adminAuthModal.hide();
      await loadConsole();
    } catch (error) {
      byId('adminAuthError').textContent = error.message;
      byId('adminAuthError').classList.add('d-block');
      byId('adminTokenInput').select();
    } finally { submit.disabled = false; }
  }

  async function openConnectionSettings() {
    try {
      const config = await api('/api/admin/salesforce/config');
      byId('callbackModeInput').value = config.callbackMode;
      byId('sfTokenUrlInput').value = config.tokenUrl;
      byId('sfWebhookUrlInput').value = config.webhookUrl;
      byId('sfClientIdInput').value = config.clientId;
      byId('sfClientSecretInput').value = '';
      byId('clientSecretHint').textContent = config.clientSecretConfigured ? '(já configurado)' : '(não configurado)';
      byId('connectionStateLabel').textContent = config.callbackMode === 'mock' ? 'Simulação local ativa' : 'Conexão não testada';
      byId('connectionFeedback').classList.add('d-none');
      byId('testConnectionButton').disabled = config.callbackMode !== 'http';
      connectionModal.show();
    } catch (error) { showToast(error.message, 'error'); }
  }

  function getConnectionFormData() {
    return {
      callbackMode: byId('callbackModeInput').value,
      tokenUrl: byId('sfTokenUrlInput').value.trim(),
      webhookUrl: byId('sfWebhookUrlInput').value.trim(),
      clientId: byId('sfClientIdInput').value.trim(),
      clientSecret: byId('sfClientSecretInput').value
    };
  }

  async function saveConnectionSettings() {
    const result = await api('/api/admin/salesforce/config', { method: 'PUT', body: JSON.stringify(getConnectionFormData()) });
    state.config.callbackMode = result.callbackMode;
    byId('clientSecretHint').textContent = result.clientSecretConfigured ? '(já configurado)' : '(não configurado)';
    byId('sfClientSecretInput').value = '';
    await loadConsole();
    return result;
  }

  async function saveConnection(event) {
    event.preventDefault();
    const button = byId('saveConnectionButton');
    button.disabled = true;
    try {
      const result = await saveConnectionSettings();
      byId('connectionStateLabel').textContent = 'Salva em memória';
      byId('connectionFeedback').textContent = 'Configuração aplicada até o servidor reiniciar. Para persistir na AWS, use SSM Parameter Store ou AWS Secrets Manager.';
      byId('connectionFeedback').classList.remove('d-none', 'error');
      if (result.callbackMode === 'mock') showToast('Modo local ativado. Nenhum callback externo será enviado.', 'info');
    } catch (error) {
      byId('connectionFeedback').textContent = error.message;
      byId('connectionFeedback').classList.remove('d-none');
      byId('connectionFeedback').classList.add('error');
      byId('connectionStateLabel').textContent = 'Erro ao salvar';
    } finally { button.disabled = false; }
  }

  async function testSalesforceConnection() {
    const button = byId('testConnectionButton');
    button.disabled = true;
    byId('connectionStateLabel').textContent = 'Testando OAuth...';
    try {
      await saveConnectionSettings();
      const result = await api('/api/admin/salesforce/test', { method: 'POST', body: '{}' });
      byId('connectionFeedback').textContent = result.message;
      byId('connectionFeedback').classList.remove('d-none', 'error');
      byId('connectionStateLabel').textContent = 'OAuth validado';
    } catch (error) {
      byId('connectionFeedback').textContent = error.message;
      byId('connectionFeedback').classList.remove('d-none');
      byId('connectionFeedback').classList.add('error');
      byId('connectionStateLabel').textContent = 'Falha no teste';
    } finally { button.disabled = byId('callbackModeInput').value !== 'http'; }
  }

  function selectQueueConversation(event) {
    const acceptButton = event.target.closest('[data-accept]');
    if (acceptButton) { event.stopPropagation(); acceptConversation(acceptButton.dataset.accept); return; }
    const button = event.target.closest('[data-identifier]');
    if (!button) return;
    const conversation = state.conversations.find((item) => item.identifier === button.dataset.identifier);
    if (!conversation) return;
    state.selectedIdentifier = conversation.identifier;
    renderConversation(); renderContext(); renderQueue(); setMobilePanel('chatPanel');
  }
  byId('queueList').addEventListener('click', selectQueueConversation);
  byId('activeList').addEventListener('click', selectQueueConversation);
  byId('queueList').addEventListener('keydown', (event) => { if (event.target.matches('[data-identifier]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectQueueConversation(event); } });
  byId('activeList').addEventListener('keydown', (event) => { if (event.target.matches('[data-identifier]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectQueueConversation(event); } });
  byId('acceptButton').addEventListener('click', () => { const conversation = getSelected(); if (conversation) acceptConversation(conversation.identifier); });
  byId('seedButton').addEventListener('click', simulateConversation);
  byId('emptySeedButton').addEventListener('click', simulateConversation);
  byId('chatSeedButton').addEventListener('click', simulateConversation);
  byId('searchInput').addEventListener('input', renderQueue);
  byId('channelFilter').addEventListener('change', renderQueue);
  byId('composerForm').addEventListener('submit', sendMessage);
  byId('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); byId('composerForm').requestSubmit(); }
  });
  byId('closeButton').addEventListener('click', () => closeModal.show());
  byId('confirmCloseButton').addEventListener('click', closeConversation);
  byId('simulateInboundButton').addEventListener('click', simulateIncoming);
  byId('privacyToggle').addEventListener('click', () => { state.revealPrivate = !state.revealPrivate; renderContext(); });
  byId('copyIdentifier').addEventListener('click', async () => {
    const conversation = getSelected();
    if (!conversation) return;
    try { await navigator.clipboard.writeText(conversation.identifier); showToast('Identificador copiado.'); }
    catch (error) { showToast('Não foi possível copiar o identificador.', 'error'); }
  });
  byId('agentStatusButton').addEventListener('click', async () => {
    try {
      const result = await api('/api/agent/status', { method: 'PUT', body: JSON.stringify({ available: !state.available }) });
      state.available = result.available;
      renderAgentStatus();
    } catch (error) { showToast(error.message, 'error'); }
  });
  byId('adminAuthForm').addEventListener('submit', authenticateAdmin);
  byId('connectionConfigButton').addEventListener('click', openConnectionSettings);
  byId('connectionForm').addEventListener('submit', saveConnection);
  byId('testConnectionButton').addEventListener('click', testSalesforceConnection);
  byId('callbackModeInput').addEventListener('change', () => {
    byId('testConnectionButton').disabled = byId('callbackModeInput').value !== 'http';
  });
  byId('resetButton').addEventListener('click', async () => {
    if (!window.confirm('Limpar todas as conversas locais de demonstração?')) return;
    try { await api('/api/demo/reset', { method: 'POST', body: '{}' }); state.selectedIdentifier = null; await refresh(); showToast('Conversas locais removidas.', 'info'); }
    catch (error) { showToast(error.message, 'error'); }
  });
  document.querySelectorAll('.mobile-tab').forEach((tab) => tab.addEventListener('click', () => setMobilePanel(tab.dataset.panel)));
  window.addEventListener('resize', () => { if (window.matchMedia('(min-width: 992px)').matches) document.querySelectorAll('.workspace-panel').forEach((panel) => panel.classList.remove('mobile-hidden')); });

  initialize();
})();