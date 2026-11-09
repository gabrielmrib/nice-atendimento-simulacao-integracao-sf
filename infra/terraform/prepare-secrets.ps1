param(
  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

function New-RandomToken {
  $bytes = New-Object byte[] 48
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-ParameterValue([string]$ParameterName, [string]$Value) {
  $temporaryFile = Join-Path $env:TEMP ("betta-secret-" + [guid]::NewGuid().ToString("N"))
  try {
    $payload = @{
      Name      = $ParameterName
      Type      = "SecureString"
      Tier      = "Standard"
      Overwrite = $true
      Value     = $Value
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($temporaryFile, $payload, [System.Text.UTF8Encoding]::new($false))
    aws ssm put-parameter --region $Region --cli-input-json "file://$temporaryFile" --query Version --output text | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Falha ao armazenar parâmetro seguro no SSM Parameter Store." }
  } finally {
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
    $Value = $null
  }
}

$adminParameter = terraform output -raw admin_token_parameter_name
if ($LASTEXITCODE -ne 0 -or -not $adminParameter) { throw "Execute terraform apply da fase base antes deste script." }
$inboundParameter = terraform output -raw inbound_api_key_parameter_name
if ($LASTEXITCODE -ne 0 -or -not $inboundParameter) { throw "Parâmetro da chave de entrada não encontrado nos outputs Terraform." }

Set-ParameterValue $adminParameter (New-RandomToken)
Set-ParameterValue $inboundParameter (New-RandomToken)

Write-Output "ADMIN_TOKEN e INBOUND_API_KEY foram gerados como SecureString Standard no SSM Parameter Store. Os valores não foram exibidos nem gravados no state Terraform."
Write-Output "Para consultar um valor, use Systems Manager > Parameter Store no Console AWS ou aws ssm get-parameter --with-decryption com o nome correspondente."