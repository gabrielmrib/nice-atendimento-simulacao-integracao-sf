# Simulador Betta Tech e NICE CXone

## Objetivo

Especificar uma aplicação web local para simular o gateway Betta Tech e uma consola de atendimento inspirada no NICE CXone. O simulador recebe eventos de um sistema que representa o Salesforce, mantém conversas em memória, atualiza a consola em tempo real e envia callbacks de volta ao Salesforce.

Este documento é o índice da especificação. Leia também:

- [Requisitos e contratos de API](docs/requisitos-e-api.md): arquitetura, payloads, estados e integrações HTTP.
- [Interface e tempo real](docs/interface-e-tempo-real.md): requisitos da consola, acessibilidade e mensagens WebSocket.
- [Critérios de aceite e decisões](docs/criterios-e-decisoes.md): comportamento verificável, configuração e pontos que precisam de confirmação.
- [Instruções para agentes](AGENTS.md): como interpretar e implementar esta especificação quando solicitado.

## Limites

- Esta especificação descreve um simulador; não representa uma integração oficial nem uma implementação de produção da NICE CXone, Betta Tech ou Salesforce.
- A persistência é em memória e se perde ao reiniciar o servidor. PostgreSQL e RabbitMQ são apenas sistemas que a arquitetura real pode representar; não devem ser instalados nesta versão do simulador.
- Não usar credenciais, tokens, dados pessoais ou segredos reais nos arquivos, exemplos, logs ou commits. Os valores de exemplo devem ser fictícios.
- A implementação deve ser feita apenas quando solicitada pelo usuário. Esta tarefa é de documentação, não de criação do aplicativo.

## Contratos pendentes de validação

Os exemplos recebidos não esclarecem se `conversationID` no callback `ACCEPT_CONVERSATION` significa o `identifier` (MessagingSessionId) ou o `conversationId` da conversa. Também não há definição inequívoca sobre a rota alternativa `/eventsLegacy`. Os documentos abaixo registram o comportamento provisório sem afirmar que essas convenções foram confirmadas pelo Salesforce. Antes de usar um endpoint real, validar esses campos e rotas com a documentação ou com uma captura aprovada do sistema de origem.