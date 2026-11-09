# Instruções para agentes

## Antes de alterar o projeto

1. Leia `specificação.md` e os três documentos em `docs/`.
2. Trate os contratos externos como exemplos a confirmar, não como documentação oficial. Preserve nomes de campo e rotas registrados até que o usuário forneça um contrato corrigido.
3. Não invente credenciais reais, não inclua segredos em código ou documentação e não envie dados de teste a serviços externos sem autorização explícita. O modo padrão deve ser `mock`; só enviar callbacks reais se `CALLBACK_MODE=http` estiver configurado deliberadamente.
4. Se um requisito for ambíguo, prefira a decisão provisória descrita na especificação e sinalize-a. Pergunte ao usuário somente quando a ambiguidade impedir uma implementação coerente.
5. Ao implementar, mantenha frontend e backend compatíveis com os eventos e rotas documentados e valide os critérios de aceite.
6. Preserve os guardas de implantação: bind público exige `ADMIN_TOKEN`, `INBOUND_API_KEY` e `TRUST_PROXY=true`; administração e eventos externos exigem HTTPS. CORS permite a própria origem HTTPS e só origens extras explícitas via `CORS_ORIGIN`. Nunca enfraqueça essas verificações para facilitar testes.
7. Credenciais Salesforce não são as credenciais das rotas OAuth mock. Não envie `SALESFORCE_CLIENT_SECRET` à interface além do modal protegido e nunca devolva/logue o segredo ou access token.

## Execução local

Para o simulador, priorize uma execução local sem build step: `npm install` e `npm start`. A interface deve estar em `/`, usar Bootstrap, e indicar claramente o modo de callback ativo. Preserve modo `mock` como padrão para que o usuário possa testar no browser sem Salesforce.