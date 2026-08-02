[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [Parameter(Mandatory = $true)][string]$DeploymentId,
  [switch]$PlanOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProductId = 'com.innorder.occ'
$StoreName = 'CurrentUser\Root'
$MaximumStateBytes = 65536

function Assert-ExactProperties($Value, [string[]]$Names, [string]$Label) {
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join '|') -cne ($expected -join '|')) { throw "$Label has unknown or missing properties" }
}

function Get-Sha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '') }
  finally { $algorithm.Dispose() }
}

if (-not [IO.Path]::IsPathRooted($StateRoot) -or [IO.Path]::GetFileName([IO.Path]::GetFullPath($StateRoot).TrimEnd('\')) -cne 'state') { throw 'StateRoot must be an absolute product state path' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$parsedDeploymentId = [Guid]::Empty
if (-not [Guid]::TryParseExact($DeploymentId, 'D', [ref]$parsedDeploymentId)) { throw 'DeploymentId must be a UUID' }
$DeploymentId = $parsedDeploymentId.ToString('D')
$statePath = [IO.Path]::Combine($StateRoot, "$DeploymentId.json")
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { [pscustomobject]@{ status = 'absent'; action = 'none'; deploymentId = $DeploymentId } | ConvertTo-Json -Compress; exit 0 }
$stateItem = Get-Item -LiteralPath $statePath -Force
if (($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $stateItem.PSIsContainer) { throw 'Certificate state must be a regular non-reparse file' }
if ($stateItem.Length -eq 0 -or $stateItem.Length -gt $MaximumStateBytes) { throw 'Certificate state size exceeds the allowed bound' }
$state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
Assert-ExactProperties $state @('version', 'productId', 'deploymentId', 'importedByProduct', 'ownedThumbprint', 'store', 'profileReferences', 'selectedProfileId') 'Certificate state'
if ($state.version -ne 1 -or $state.productId -cne $ProductId -or $state.deploymentId -cne $DeploymentId -or $state.importedByProduct -ne $true -or $state.store -cne $StoreName -or [string]$state.ownedThumbprint -notmatch '^[0-9A-F]{64}$') { throw 'Certificate state ownership mismatch' }
$references = @($state.profileReferences)
foreach ($reference in $references) { $profileId = [Guid]::Empty; if (-not [Guid]::TryParseExact([string]$reference, 'D', [ref]$profileId)) { throw 'Certificate state contains an invalid profile reference' } }
if ($null -ne $state.selectedProfileId -and [string]$state.selectedProfileId -notin $references) { throw 'Selected profile is not a certificate reference' }
if ($references.Count -ne 0) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PROFILE_REFERENCES'; referenceCount = $references.Count; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }

$plan = [pscustomobject]@{ status = 'planned'; action = 'remove-if-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint }
if ($PlanOnly) { $plan | ConvertTo-Json -Compress; exit 0 }

$store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
try {
  $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq [string]$state.ownedThumbprint })
  if ($exact.Count -ne 1) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }
  $store.Remove($exact[0])
} finally { $store.Close() }
Remove-Item -LiteralPath $statePath -Force
[pscustomobject]@{ status = 'removed'; action = 'removed-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress
