data "aws_caller_identity" "current" {}

data "archive_file" "application" {
  type        = "zip"
  source_dir  = "${path.module}/../.."
  output_path = "${path.module}/.terraform/betta-desk.zip"
  excludes = [
    ".git/**",
    ".env",
    ".env.*",
    "node_modules/**",
    "infra/**",
    "test/**",
    "*.tfstate*"
  ]
}

locals {
  account_id             = data.aws_caller_identity.current.account_id
  resource_prefix        = "${var.project_name}-${local.account_id}"
  bundle_key             = "${var.project_name}/${data.archive_file.application.output_md5}/application.zip"
  admin_parameter_name   = "/${var.project_name}/${local.account_id}/admin-token"
  inbound_parameter_name = "/${var.project_name}/${local.account_id}/inbound-api-key"
  admin_parameter_arn    = "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${local.admin_parameter_name}"
  inbound_parameter_arn  = "arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${local.inbound_parameter_name}"

  runtime_variables = merge({
    HOST                = "0.0.0.0"
    PORT                = "433"
    NODE_ENV            = "production"
    TRUST_PROXY         = "true"
    CALLBACK_MODE       = var.callback_mode
    CALLBACK_TIMEOUT_MS = tostring(var.callback_timeout_ms)
    MAX_JSON_BODY       = "2mb"
    MAX_FILE_SIZE_BYTES = "1048576"
    AGENT_ID            = var.agent_id
    AGENT_NAME          = var.agent_name
    }, var.cors_origin != "" ? {
    CORS_ORIGIN = var.cors_origin
    } : {}, var.callback_mode == "http" ? {
    SALESFORCE_TOKEN_URL   = var.salesforce_token_url
    SALESFORCE_WEBHOOK_URL = var.salesforce_webhook_url
    SALESFORCE_CLIENT_ID   = var.salesforce_client_id
  } : {})

  parameter_read_arns = concat(
    [
      local.admin_parameter_arn,
      local.inbound_parameter_arn
    ],
    var.callback_mode == "http" && var.salesforce_client_secret_parameter_name != "" ? ["arn:aws:ssm:${var.aws_region}:${local.account_id}:parameter${var.salesforce_client_secret_parameter_name}"] : []
  )
}

resource "aws_vpc" "application" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${var.project_name}-vpc"
    Project     = var.project_name
    Environment = "poc"
  }
}

resource "aws_internet_gateway" "application" {
  vpc_id = aws_vpc.application.id

  tags = {
    Name    = "${var.project_name}-igw"
    Project = var.project_name
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.application.id
  cidr_block              = "10.42.1.0/24"
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = {
    Name    = "${var.project_name}-public"
    Project = var.project_name
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.application.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.application.id
  }

  tags = {
    Name    = "${var.project_name}-public"
    Project = var.project_name
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_s3_bucket" "application" {
  bucket        = "${local.resource_prefix}-${var.aws_region}"
  force_destroy = true

  tags = {
    Project     = var.project_name
    Environment = "poc"
  }
}

resource "aws_s3_bucket_public_access_block" "application" {
  bucket                  = aws_s3_bucket.application.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "application" {
  bucket = aws_s3_bucket.application.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "application" {
  bucket       = aws_s3_bucket.application.id
  key          = local.bundle_key
  source       = data.archive_file.application.output_path
  source_hash  = data.archive_file.application.output_md5
  content_type = "application/zip"

  depends_on = [
    aws_s3_bucket_public_access_block.application,
    aws_s3_bucket_server_side_encryption_configuration.application
  ]
}

data "aws_iam_policy_document" "ec2_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.resource_prefix}-ec2-runtime"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "runtime_access" {
  name = "read-poc-source-and-parameters"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.application.arn}/${aws_s3_object.application.key}"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = local.parameter_read_arns
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.resource_prefix}-ec2-profile"
  role = aws_iam_role.instance.name
}

resource "aws_security_group" "application" {
  name        = "${local.resource_prefix}-web"
  description = "HTTPS via Caddy; no SSH or direct Node port"
  vpc_id      = aws_vpc.application.id

  ingress {
    description = "HTTP for ACME challenge and HTTPS redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS application traffic"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound package, AWS API, and Salesforce HTTPS"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project     = var.project_name
    Environment = "poc"
  }
}

resource "aws_instance" "application" {
  count                       = var.deploy_instance ? 1 : 0
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.application.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    aws_region    = var.aws_region
    source_bucket = aws_s3_bucket.application.id
    source_key    = aws_s3_object.application.key
    app_domain    = var.app_domain
    runtime_config_json = jsonencode(merge(local.runtime_variables, {
      AWS_REGION                        = var.aws_region
      _ADMIN_TOKEN_PARAMETER_NAME       = local.admin_parameter_name
      _INBOUND_API_KEY_PARAMETER_NAME   = local.inbound_parameter_name
      _SALESFORCE_SECRET_PARAMETER_NAME = var.callback_mode == "http" ? var.salesforce_client_secret_parameter_name : ""
    }))
  })

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = {
    Name        = var.project_name
    Project     = var.project_name
    Environment = "poc"
  }

  depends_on = [
    aws_iam_role_policy_attachment.ssm,
    aws_iam_role_policy.runtime_access,
    aws_s3_object.application
  ]

  lifecycle {
    precondition {
      condition     = var.ami_id != ""
      error_message = "Escolha no Console AWS uma AMI Linux x86_64 elegível para sua conta/região e defina ami_id."
    }
    precondition {
      condition     = var.app_domain != ""
      error_message = "Defina app_domain com um hostname DNS público apontado para o IP da instância para habilitar HTTPS."
    }
    precondition {
      condition     = var.callback_mode != "http" || (can(regex("^https://", var.salesforce_token_url)) && can(regex("^https://", var.salesforce_webhook_url)) && var.salesforce_client_id != "" && var.salesforce_client_secret_parameter_name != "")
      error_message = "callback_mode=http exige URLs HTTPS, Client ID e nome do Client Secret no SSM Parameter Store."
    }
  }
}