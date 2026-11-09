# Betta Desk

Simulador local de gateway e consola de atendimento. O modo padrão é `mock`: fila, chat e ações do atendente funcionam sem acessar serviços externos.

## Iniciar localmente

Requer Node.js 18 ou superior.

```powershell
npm install
npm start
```

Abra <http://localhost:433>. Não é necessário criar `.env` para a demonstração local.

## AWS e Free Tier

O deploy usa uma EC2 `t3.micro`, sem ALB, NAT Gateway ou Elastic IP. Caddy termina HTTPS com certificado Let's Encrypt. É necessário um domínio/subdomínio público apontado para o IP da instância. Um DNS dinâmico gratuito pode servir para a POC.

`t3.micro` pode ser elegível a free tier/créditos, dependendo da data de abertura, região e plano da conta. Confirme a elegibilidade no Console AWS antes do `apply`. IPv4 público, EBS, S3 e tráfego podem gerar cobranças. Esta configuração reduz componentes, mas não garante custo zero.

O Security Group libera somente portas 80 e 443; SSH e a porta Node 433 não são expostos. Use Systems Manager Session Manager para manutenção. O processo exige `ADMIN_TOKEN`, `INBOUND_API_KEY` e `TRUST_PROXY=true` em bind público. A mesma origem HTTPS é permitida automaticamente.

## Deploy Terraform

Pré-requisitos: Terraform 1.8+, AWS CLI autenticado, permissões para EC2, S3, SSM Parameter Store e IAM. Docker Desktop não é necessário. O `t3.micro` precisa aparecer como elegível/compensado no Free Tier da sua conta; confirme também custos de IPv4 público e EBS.

No PowerShell, começando na raiz do projeto:

```powershell
Set-Location .\infra\terraform
Copy-Item terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan
terraform apply
```

Essa fase cria o bundle de aplicação no S3 privado, as roles e o Security Group, mas ainda não cria a instância.

Gere `ADMIN_TOKEN` e `INBOUND_API_KEY` como `SecureString` Standard no SSM Parameter Store:

```powershell
.\prepare-secrets.ps1 -Region us-east-1
```

No Console AWS, em EC2 > Launch instance, escolha uma Amazon Linux 2023 x86_64 marcada como elegível para o Free Tier e copie o AMI ID da região `us-east-1`. Não precisa concluir o Launch pelo Console. Em `terraform.tfvars`, configure `deploy_instance`, `ami_id` e `app_domain`:

```hcl
deploy_instance = true
ami_id          = "ami-COLE_O_ID_ESCOLHIDO"
app_domain      = "poc.seudominio.com"
```

Use um hostname público seu ou DNS dinâmico gratuito. Depois execute:

```powershell
terraform plan
terraform apply
terraform output -raw instance_public_ip
terraform output -raw app_url
```

Aponte o registro A do domínio para o IP exibido. Após a propagação DNS, Caddy obtém o certificado TLS; abra a URL `app_url` e autentique com o parâmetro `ADMIN_TOKEN` no SSM.

O state do Terraform guarda apenas os nomes dos parâmetros, não seus valores. O app inicia em `mock`; nenhum callback Salesforce é enviado.

Para habilitar callbacks reais de forma persistente, crie o Client Secret como `SecureString` Standard separado no Parameter Store. No `terraform.tfvars`, configure `callback_mode = "http"`, URLs HTTPS, `salesforce_client_id` e `salesforce_client_secret_parameter_name`. Reaplicar substitui a instância para carregar essa configuração. Não coloque o valor do Client Secret no tfvars.

## Integração Salesforce

Callbacks reais só são enviados no modo `http`. A Connected App ou External Client App deve permitir OAuth Client Credentials e estar associada a um usuário de integração com as permissões necessárias. O Apex REST deve receber os três eventos documentados. Eventos de entrada para `/api/customer/events` precisam do header `X-Inbound-Api-Key` correspondente ao parâmetro SSM.

O botão **Testar OAuth** valida a obtenção do token; não envia um evento de negócio nem valida a lógica Apex. Confirme os payloads com o administrador Salesforce antes de usar dados reais.

## Testes

```powershell
npm test
```

O estado da aplicação fica em memória. Este projeto não é uma integração oficial da NICE CXone, Betta Tech ou Salesforce.