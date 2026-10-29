<#
    Provisions everything and prints the three things you still need:
      1. the deployment token to paste into GitHub
      2. the default hostname
      3. the exact DNS records for namethattune.checkthislist.com

    Run it once. It is idempotent, so running it again is harmless.

    Usage:
      ./infra/deploy.ps1
      ./infra/deploy.ps1 -ResourceGroup my-rg -Location westus2
#>

[CmdletBinding()]
param(
    [string]$ResourceGroup = 'namethattune-rg',
    [string]$Location = 'westus2',
    [string]$NamePrefix = 'namethattune',
    [string]$CustomDomain = 'namethattune.checkthislist.com'
)

$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

Step "Checking you are signed in"
$account = az account show --output json 2>$null
if (-not $account) {
    throw "Not signed in. Run 'az login' first."
}
$sub = ($account | ConvertFrom-Json)
Write-Host "    subscription: $($sub.name)"

Step "Creating resource group '$ResourceGroup' in $Location"
az group create --name $ResourceGroup --location $Location --output none

Step "Deploying Cosmos DB and the Static Web App (a few minutes)"
$bicep = Join-Path $PSScriptRoot 'main.bicep'
$deployment = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file $bicep `
    --parameters namePrefix=$NamePrefix location=$Location staticWebAppLocation=$Location `
    --query properties.outputs `
    --output json | ConvertFrom-Json

$swaName = $deployment.staticWebAppName.value
$hostname = $deployment.defaultHostname.value
$cosmosName = $deployment.cosmosAccountName.value

Step "Reading the deployment token"
$token = az staticwebapp secrets list `
    --name $swaName `
    --resource-group $ResourceGroup `
    --query 'properties.apiKey' `
    --output tsv

Write-Host "`n"
Write-Host "================ WHAT YOU DO NEXT ================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Static Web App : $swaName"
Write-Host "Cosmos account : $cosmosName"
Write-Host "Live now at    : https://$hostname"
Write-Host ""
Write-Host "1) GitHub secret" -ForegroundColor Yellow
Write-Host "   In your repo: Settings > Secrets and variables > Actions > New repository secret"
Write-Host "   Name : AZURE_STATIC_WEB_APPS_API_TOKEN"
Write-Host "   Value: $token"
Write-Host ""
Write-Host "2) DNS at checkthislist.com" -ForegroundColor Yellow
Write-Host "   Add a CNAME:"
Write-Host "     Host  : namethattune"
Write-Host "     Points: $hostname"
Write-Host "     TTL   : 3600"
Write-Host ""
Write-Host "3) Then attach the domain (after DNS has propagated):" -ForegroundColor Yellow
Write-Host "   az staticwebapp hostname set --name $swaName --resource-group $ResourceGroup --hostname $CustomDomain"
Write-Host ""
Write-Host "==================================================" -ForegroundColor Yellow
