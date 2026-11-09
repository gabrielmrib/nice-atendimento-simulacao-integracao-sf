# Interface e tempo real

## Consola do agente

Criar uma consola web responsiva com Bootstrap, inspirada em ferramentas de atendimento, sem alegar ser a interface oficial NICE CXone. Em telas largas, usar três áreas funcionais:

1. **Fila e atendimentos:** disponibilidade do agente, contador, filtro por skill/canal, conversas pendentes e ativas. Cada item mostra nome, canal, operação e estado; conversas pendentes têm ação para aceitar.
2. **Conversa:** cliente e identificadores no cabeçalho, histórico cronológico, compositor de mensagem, envio e encerramento com confirmação.
3. **Contexto:** dados cadastrais, dados da operação, skill/fila, identificador e dados extras expansíveis.

Em telas estreitas, reorganizar em navegação por abas ou painéis empilhados; não comprimir as três colunas até ficarem inutilizáveis. Mostrar estados vazios, conexão WebSocket indisponível, carregamento, erro de callback e confirmação de envio/fechamento. Exibir permanentemente se o sistema está no modo local simulado ou no modo HTTP Salesforce. Não renderizar conteúdo recebido como HTML.

## Histórico

- `sender: "user"`: mensagem recebida do cliente, à esquerda.
- `sender: "bot"`: mensagem do bot, com identificação visual “Bot”; extrair texto das formas de `message` mostradas nos exemplos (`{text}` ou `[{default:{text,type}}]`).
- Mensagens do atendente: à direita, com identificação do agente e estado de envio quando aplicável.
- Arquivos: mostrar nome, legenda e tipo; preview apenas quando seguro e suportado.
- Exibir horário quando disponível, mantendo a ordem recebida. Mensagens desconhecidas devem ser apresentadas de forma segura, sem quebrar a conversa.

O atalho `Enter` envia; `Shift+Enter` insere nova linha. Desabilitar envio durante uma requisição e manter o texto digitado se houver falha. O botão de encerrar exige confirmação.

## WebSocket

Usar protocolo JSON sobre `ws`. Cada mensagem do servidor tem envelope consistente:

```json
{
  "event": "NEW_QUEUED_CONVERSATION",
  "data": { "identifier": "session-demo-001" }
}
```

Eventos mínimos: `NEW_QUEUED_CONVERSATION` após abertura, `CONVERSATION_UPDATED` após mensagem recebida ou mudança de estado, `CONVERSATION_CLOSED` após encerramento. `data` deve incluir o objeto necessário para atualizar o cliente (sem exigir recarga completa). Ao conectar/reconectar, o browser busca o snapshot atual pela API REST; WebSocket não é a fonte de persistência.

Ao desconectar, indicar o estado e tentar reconectar com intervalo crescente e limite. Uma atualização perdida deve ser recuperável pela consulta REST. O servidor não deve presumir que há um único browser conectado.

## Campos de contexto

- Cadastro: `contact.name`, `contact.email`, `contact.phone` e CPF, priorizando `contact.cpf` e usando `extraInfo.CPF` como fallback.
- Operação: `extraInfo.CanalOperacao`, `QueueNice`, `skillId`, `extraInfo.instancia` e demais `extraInfo`.
- Identidade da sessão: `identifier`, com botão de cópia e feedback acessível.

Como os exemplos podem conter PII, ocultar CPF e telefone por padrão (por exemplo, máscara parcial) e só revelar sob ação explícita na sessão local. Não persistir nem registrar esses dados fora da memória da aplicação.