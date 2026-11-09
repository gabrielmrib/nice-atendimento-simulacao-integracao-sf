output "app_url" {
  description = "URL HTTPS depois de deploy_instance=true e DNS apontado para a EC2."
  value       = var.deploy_instance ? "https://${var.app_domain}" : null
}

output "instance_public_ip" {
  description = "IPv4 público para o registro DNS A do hostname app_domain."
  value       = var.deploy_instance ? aws_instance.application[0].public_ip : null
}

output "instance_id" {
  description = "EC2 instance ID; use Systems Manager Session Manager para manutenção."
  value       = var.deploy_instance ? aws_instance.application[0].id : null
}

output "source_bucket_name" {
  description = "Bucket privado do bundle publicado pelo Terraform."
  value       = aws_s3_bucket.application.id
}

output "admin_token_parameter_name" {
  description = "Nome SSM SecureString Standard do token administrativo; o valor não fica no state."
  value       = local.admin_parameter_name
}

output "inbound_api_key_parameter_name" {
  description = "Nome SSM SecureString Standard da chave X-Inbound-Api-Key; o valor não fica no state."
  value       = local.inbound_parameter_name
}