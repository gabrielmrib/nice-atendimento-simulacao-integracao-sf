variable "aws_region" {
  description = "Região AWS usada pela EC2 e serviços auxiliares."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefixo curto para recursos da POC."
  type        = string
  default     = "betta-desk-poc"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,23}$", var.project_name))
    error_message = "project_name deve ter 3 a 24 caracteres minúsculos, números ou hífens e começar por letra."
  }
}

variable "deploy_instance" {
  description = "Mude para true depois de criar os secrets e apontar app_domain para o IP EC2."
  type        = bool
  default     = false
}

variable "ami_id" {
  description = "AMI ID Linux x86_64 escolhido no Console AWS para a região e free tier da conta."
  type        = string
  default     = ""

  validation {
    condition     = var.ami_id == "" || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id deve ser vazio ou um ID no formato ami-... da região selecionada."
  }
}

variable "app_domain" {
  description = "Nome DNS público apontado para o IP EC2; necessário para TLS automático do Caddy."
  type        = string
  default     = ""

  validation {
    condition     = var.app_domain == "" || can(regex("^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.app_domain))
    error_message = "app_domain deve ser um hostname público, por exemplo poc.seudominio.com."
  }
}

variable "instance_type" {
  description = "Verifique a elegibilidade de free tier/créditos para a conta e região antes do apply."
  type        = string
  default     = "t3.micro"
}

variable "availability_zone" {
  description = "Zona de disponibilidade da subnet pública; deve pertencer à aws_region."
  type        = string
  default     = "us-east-1a"
}

variable "root_volume_gb" {
  description = "Disco criptografado da instância EC2."
  type        = number
  default     = 12
}

variable "callback_mode" {
  description = "mock não envia callbacks; http usa OAuth Salesforce e o Apex REST configurado."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "http"], var.callback_mode)
    error_message = "callback_mode deve ser mock ou http."
  }
}

variable "salesforce_token_url" {
  description = "URL OAuth da org, por exemplo test.salesforce.com na sandbox."
  type        = string
  default     = "https://login.salesforce.com/services/oauth2/token"
}

variable "salesforce_webhook_url" {
  description = "URL HTTPS da classe Apex REST de callbacks."
  type        = string
  default     = ""
}

variable "salesforce_client_id" {
  description = "Client ID da Connected App / External Client App; não é segredo."
  type        = string
  default     = ""
}

variable "salesforce_client_secret_parameter_name" {
  description = "Nome de um parâmetro SecureString Standard no SSM Parameter Store para Client Secret. Nunca passe o valor neste arquivo."
  type        = string
  default     = ""
}

variable "cors_origin" {
  description = "Origens HTTPS adicionais autorizadas. A origem HTTPS do próprio domínio é aceita automaticamente."
  type        = string
  default     = ""
}

variable "callback_timeout_ms" {
  description = "Timeout HTTP para token e callback Salesforce."
  type        = number
  default     = 8000
}

variable "agent_id" {
  type    = string
  default = "9942"
}

variable "agent_name" {
  type    = string
  default = "Atendente da POC"
}