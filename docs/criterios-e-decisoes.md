# Critérios de aceite e decisões

## Critérios de aceite

1. `npm install` seguido de `npm start` inicia o servidor na porta configurada e entrega a consola em `/`.
2. As duas rotas OAuth simuladas retornam o contrato documentado para credenciais configuradas e HTTP 401 para credenciais inválidas.
3. `OPEN_CONVERSATION` cria uma única conversa `QUEUED`, retorna o `requestId` e atualiza uma consola conectada sem recarregar a página.
4. `SEND_MESSAGE` recebido aparece no histórico como mensagem do cliente; uma conversa inexistente gera HTTP 404 e uma fechada não é reaberta implicitamente.
5. `UPLOAD_FILE` e `SEND_FILE` respeitam limites configurados e não permitem execução de conteúdo recebido.
6. No modo padrão `mock`, aceitar, enviar e encerrar funcionam sem conexão externa, atualizam a consola e identificam o resultado como simulação local. No modo `http`, essas ações geram os callbacks documentados; falhas de rede ou HTTP são comunicadas e não deixam o estado visual/local afirmar sucesso.
7. Mensagens e estado continuam coerentes ao abrir mais de uma consola; após reconexão WebSocket, a UI recupera o estado via REST.
8. A interface funciona em desktop e celular, tem estados vazios/erro e pode ser operada por teclado. Texto de evento não é interpretado como HTML.
9. O repositório não contém segredos ou dados pessoais reais; logs não expõem tokens, credenciais, CPF, telefone, email ou mensagens completas.

## Configuração mínima

Documentar no `.env.example` (sem valores secretos): `HOST` (`127.0.0.1` por padrão), `PORT`, `ADMIN_TOKEN`, `INBOUND_API_KEY`, `TRUST_PROXY`, `CALLBACK_MODE` (`mock` por padrão; `http` para integração real), `SALESFORCE_TOKEN_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_WEBHOOK_URL`, `CORS_ORIGIN` (origens HTTPS adicionais; a própria origem é aceita), `CALLBACK_TIMEOUT_MS`, `MAX_JSON_BODY` e `MAX_FILE_SIZE_BYTES`. Em bind não-loopback, exigir `ADMIN_TOKEN`, `INBOUND_API_KEY` e `TRUST_PROXY=true` para TLS no load balancer. Não versionar `.env`.

Scripts esperados no `package.json`: `start` e, se houver testes, `test`. A implementação deve incluir testes automatizados para as rotas de evento, transições de estado e falha de callback; a validação manual do WebSocket não substitui testes HTTP.

## Decisões ainda pendentes

Confirmar com o responsável pelo contrato Salesforce antes de conectar a um endpoint real:

- No callback `ACCEPT_CONVERSATION`, `conversationID` recebe `identifier` ou `conversationId`? A capitalização `conversationID` é intencional?
- A rota legada é exatamente `/eventsLegacy` na raiz ou `/api/customer/eventsLegacy`?
- O formato de anexos é JSON com Base64, multipart ou outro? Quais tamanhos e tipos são aceitos?
- O Salesforce exige autenticação, headers adicionais ou formato de resposta específico no webhook? Há política de retry/idempotência?
- `QueueNice` é sempre propriedade de topo ou pode vir em `parameters`/`extraInfo`? Quais campos são obrigatórios por ação?
- O token fictício precisa atender somente às rotas locais do simulador ou também deve ser aceito por algum cliente de teste específico?

Enquanto não houver resposta, seguir as convenções provisórias descritas em `requisitos-e-api.md`, manter as URLs e segredos configuráveis e não afirmar compatibilidade validada com Salesforce real.