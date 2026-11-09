# Requisitos e contratos de API

## Arquitetura

```text
Sistema de origem / Salesforce (simulado)
    -- HTTP: eventos de cliente --> Gateway Betta simulado (Express)
    <-- HTTP: callbacks do atendente -- Gateway Betta simulado
                                         <--> WebSocket: eventos da consola
                                      Consola NICE CXone simulada (browser)
```

O servidor Node.js/Express entrega os arquivos estáticos e expõe as APIs HTTP e o servidor WebSocket. Use `ws` para WebSockets, `cors` para CORS, `dotenv` para configuração e `axios` para callbacks HTTP. O frontend usa HTML, CSS e JavaScript sem framework, com Bootstrap para os componentes responsivos. A aplicação não deve depender de build step para iniciar.

Configuração padrão: `127.0.0.1:433`, substituível por `HOST` e `PORT` (por exemplo, `127.0.0.1:3000`). O bind deve permanecer em loopback por padrão; expor em rede é uma decisão explícita e exige proteção de acesso apropriada. Valide a origem do WebSocket usando a mesma lista `CORS_ORIGIN` permitida para HTTP. Armazene conversas em `Map`, indexadas por `identifier`. Essa escolha é apenas para simulação local, sem garantia de persistência ou alta disponibilidade.

## Regras comuns

- JSON inválido ou payload incompatível deve receber erro HTTP 400 em JSON, sem derrubar o processo.
- Ações desconhecidas devem receber HTTP 400. Conversa inexistente deve receber HTTP 404 quando a ação exige conversa existente.
- Eventos aceitos devem responder HTTP 200 com `{"requestId":"<valor recebido ou null>","message":"OK"}`.
- Configure o limite de tamanho do body. Para anexos, aceite Base64 em JSON com limite configurável, mantendo o conteúdo apenas na memória e omitindo os bytes nas respostas REST/WebSocket; não interpretar strings como caminhos locais nem gravar arquivos no disco nesta versão.
- Não registrar `client_secret`, tokens, CPF, telefone, email ou conteúdo integral de mensagens. CORS deve permitir configuração por ambiente; modo de desenvolvimento pode permitir localhost.
- As rotas OAuth simuladas retornam um token fictício e não autenticam no Salesforce. A integração Salesforce usa `SALESFORCE_TOKEN_URL`, `SALESFORCE_CLIENT_ID` e `SALESFORCE_CLIENT_SECRET`, que são credenciais distintas.
- Em bind de rede, exigir `ADMIN_TOKEN` para as APIs do painel e `INBOUND_API_KEY` para eventos externos. A aplicação não deve iniciar em bind não-loopback se qualquer chave estiver ausente.
- Exigir HTTPS para administração e eventos de entrada quando o servidor estiver em rede. Atrás de TLS termination, `TRUST_PROXY=true` só deve ser usado quando o proxy/load balancer for controlado. A própria origem HTTPS do serviço é aceita automaticamente; `CORS_ORIGIN` adiciona apenas origens HTTPS explícitas.
- Enviar a chave administrativa em `X-Admin-Token`, a chave de eventos em `X-Inbound-Api-Key`. Nunca enviar chaves na query string, armazená-las em `localStorage` ou registrá-las em logs. A autenticação inicial do WebSocket ocorre por mensagem `AUTH` no frame, antes de assinar eventos.

## Autenticação simulada

Rotas: `POST /api/Agent/1.0/token` e `POST /api/NiceConversations/1.0/token`.

Entrada JSON esperada: `grant_type: "client_credentials"`, `client_id` e `client_secret`. Estas rotas são somente mocks locais, usando `OAUTH_CLIENT_ID` e `OAUTH_CLIENT_SECRET`; não são usadas pelos callbacks Salesforce. Resposta de sucesso:

```json
{
  "access_token": "mocked_bearer_token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "admin"
}
```

Credenciais inválidas devem receber HTTP 401. O token é exclusivamente fictício e não autoriza acesso a nenhum serviço real. Em rede, as rotas OAuth simuladas também exigem `X-Admin-Token`.

## Eventos recebidos

Rotas: `POST /api/customer/events` e, provisoriamente, `POST /eventsLegacy`. Ambas devem usar o mesmo handler. A rota alternativa precisa ser confirmada com o sistema de origem; não inferir outro caminho, como `/api/customer/eventsLegacy`.

### `OPEN_CONVERSATION`

Exemplo fictício e reduzido:

```json
{
  "action": "OPEN_CONVERSATION",
  "conversationId": "conv-demo-001",
  "identifier": "session-demo-001",
  "requestId": "req-demo-001",
  "skillId": "35629200",
  "QueueNice": "SEGURO",
  "agent": null,
  "parameters": {
    "contact": {
      "id": 123,
      "channel": "whatsapp",
      "name": "Cliente de demonstração",
      "email": "cliente@example.test",
      "phone": "0000000000",
      "cpf": "00000000000",
      "extra": {},
      "history": [
        { "id": null, "time": "2025-02-18T20:12:20.191Z", "sender": "user", "message": { "text": "Olá" } },
        { "id": null, "time": "2025-02-18T20:12:21.557Z", "sender": "bot", "message": [{ "default": { "text": "Olá!", "type": "text" } }] }
      ]
    },
    "extraInfo": {
      "CPF": "00000000000",
      "Fila": "FILA_DEMO",
      "Nome": "Cliente de demonstração",
      "E-mail": "cliente@example.test",
      "Telefone": "0000000000",
      "instancia": "instancia-demo",
      "contact_id": 123,
      "CanalOperacao": "operacao_demo",
      "tipodeservico": "Atendimento_Humano"
    }
  },
  "timestamp": 1757016972855
}
```

Validar a presença de `identifier`, criar conversa com estado `QUEUED`, preservar os campos recebidos necessários à consola e publicar `NEW_QUEUED_CONVERSATION`. Se já existir conversa com o mesmo `identifier`, atualizar conforme uma política idempotente (não criar duas entradas na fila); preservar mensagens já anexadas quando possível. Responder no formato comum.

### `SEND_MESSAGE` recebido

O evento recebido do cliente/bot tem `parameters.messages` como lista de strings, além de `identifier`, `conversationId` e, opcionalmente, `requestId`. Localizar a conversa por `identifier`, anexar uma mensagem de usuário para cada item da lista, publicar `CONVERSATION_UPDATED` e responder no formato comum. Se o estado estiver `CLOSED`, não reabrir silenciosamente; responder HTTP 409.

### `UPLOAD_FILE` e `SEND_FILE`

Aceitar os nomes de ação acima como aliases provisórios. O objeto de arquivo pode conter `file` em Base64, `contentType`, `name` e `caption`. Validar tamanho e tipo declarados; guardar o conteúdo apenas na memória durante a vida do processo. O frontend deve mostrar o nome, legenda e tipo, e exibir preview somente para tipos suportados com segurança. Não criar link público para arquivo nem interpretar HTML/SVG ativo. O formato exato do payload precisa ser validado com o emissor.

### `CLOSE_CONVERSATION` recebido

Localizar a conversa por `identifier`, alterar estado para `CLOSED`, publicar `CONVERSATION_CLOSED` e responder no formato comum. Repetir o fechamento de uma conversa já fechada não deve duplicar efeitos.

## Callbacks enviados ao Salesforce

O padrão é `CALLBACK_MODE=mock`: nenhuma requisição externa é feita, e as ações do agente são concluídas localmente com indicação explícita de “Simulado localmente”, sem afirmar entrega ao Salesforce. Para integração, definir `CALLBACK_MODE=http`, `SALESFORCE_TOKEN_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` e `SALESFORCE_WEBHOOK_URL`. O servidor solicita token OAuth 2.0 com `grant_type=client_credentials`, guarda-o em cache até perto do vencimento e envia o callback JSON por `POST` com `Authorization: Bearer`. `SALESFORCE_TOKEN_URL` deve apontar à org/ambiente correto; a Connected App/External Client App deve permitir Client Credentials Flow e ter usuário de execução com acesso à classe Apex REST. O token não deve ser retornado à consola nem registrado. Timeout e falhas não-2xx/rede devem ser tratados sem marcar a ação como entregue.

O botão **Configurar conexão** permite testar OAuth e salvar a configuração em memória até o processo reiniciar. Para persistência em AWS, usar variáveis de ambiente, SSM Parameter Store ou Secrets Manager. O teste verifica a emissão do token, mas não valida o contrato ou a lógica da classe Apex REST.

### Aceite: `ACCEPT_CONVERSATION`

O exemplo de origem usa `conversationID` (D maiúsculo) e o valor parece ser o `identifier`, enquanto os demais eventos distinguem `conversationId` de `identifier`. Até validação do contrato, preservar o formato apresentado e definir `conversationID` como `identifier`:

```json
{
  "action": "ACCEPT_CONVERSATION",
  "conversationID": "session-demo-001",
  "parameters": { "agent": { "id": 9942, "name": "Atendente de demonstração" } },
  "timestamp": 1597257441698
}
```

Ao aceitar, reservar a conversa mudando estado de `QUEUED` para `ACCEPTING`, impedindo aceite concorrente por outra consola. Em sucesso, mudar para `ACTIVE`, atribuir o atendente e atualizar as consolas. No modo `mock`, concluir localmente e identificar o resultado como simulado. No modo `http`, só efetivar o aceite após callback bem-sucedido; em falha, restaurar `QUEUED` e informar a consola.

### Mensagem do atendente: `SEND_MESSAGE`

Enviar `conversationId`, `identifier`, `agentId`, `parameters.agent.name`, `parameters.messages` (lista de uma string) e `timestamp`, conforme o exemplo de origem. A mensagem passa a fazer parte do histórico local somente após sucesso do callback, ou deve ser identificada claramente como não enviada enquanto aguarda/falha. Desabilitar envio vazio e permitir nova tentativa após falha.

### Encerramento: `CLOSE_CONVERSATION`

Enviar `conversationId`, `identifier`, `requestId` e `timestamp`. Exigir confirmação na consola. Atualizar estado local para `CLOSED` após sucesso do callback; em caso de falha, manter a conversa aberta e informar o erro.

## Rotas internas da consola

Estas rotas pertencem ao simulador, não são contratos Salesforce. Use-as para permitir que o frontend solicite ações sem expor URL ou lógica do webhook no browser:

- `POST /api/agent/conversations/:identifier/accept`
- `POST /api/agent/conversations/:identifier/messages` com `{ "message": "..." }`
- `POST /api/agent/conversations/:identifier/close`
- `PUT /api/agent/status` com `{ "available": true|false }` para controlar a disponibilidade compartilhada do agente.
- `GET /api/admin/salesforce/config`, `PUT /api/admin/salesforce/config` e `POST /api/admin/salesforce/test` para a configuração protegida do painel. A resposta nunca inclui Client Secret nem access token.
- `POST /api/auth/check` valida a chave administrativa usada na sessão do browser; `/api/config` só revela se a autenticação está habilitada.

Validar estado antes de cada ação. Retornar JSON com o estado atualizado e o modo/resultado de entrega em sucesso, e erro legível/estruturado em falha. A lista e os detalhes da consola podem ser fornecidos por `GET /api/agent/conversations` e `GET /api/agent/conversations/:identifier`.