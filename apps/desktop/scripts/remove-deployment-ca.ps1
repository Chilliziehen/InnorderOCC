[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [Parameter(Mandatory = $true)][string]$DeploymentId,
  [string]$TestStoreRoot,
  [switch]$DevelopmentTestMode,
  [switch]$PlanOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProductId = 'com.innorder.occ'
$StoreName = 'CurrentUser\Root'
$MaximumStateBytes = 65536
$UuidV4Pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

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

function Enter-LifecycleLock([string]$Root) {
  $lockPath = [IO.Path]::Combine($Root, '.deployment-ca.lifecycle.lock')
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    try { return [pscustomobject]@{ Stream = [IO.File]::Open($lockPath, 'CreateNew', 'ReadWrite', 'None'); Path = $lockPath } }
    catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
  }
  throw 'Timed out acquiring deployment CA lifecycle lock'
}

function Read-StrictState([string]$Path, [string]$ExpectedDeploymentId) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -or $item.Length -eq 0 -or $item.Length -gt $MaximumStateBytes) { throw 'Certificate state must be a bounded regular non-reparse file' }
  $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  Assert-ExactProperties $value @('version', 'productId', 'deploymentId', 'importedByProduct', 'managed', 'ownedThumbprint', 'store', 'profileReferences', 'selectedProfileId') 'Certificate state'
  if ($value.version -ne 1 -or $value.productId -cne $ProductId -or $value.deploymentId -cne $ExpectedDeploymentId -or $value.importedByProduct -isnot [bool] -or $value.managed -isnot [bool] -or $value.managed -ne $true -or $value.store -cne $StoreName -or [string]$value.ownedThumbprint -notmatch '^[0-9A-F]{64}$') { throw 'Certificate state ownership mismatch' }
  return $value
}

if (-not [IO.Path]::IsPathRooted($StateRoot) -or [IO.Path]::GetFileName([IO.Path]::GetFullPath($StateRoot).TrimEnd('\')) -cne 'state') { throw 'StateRoot must be an absolute product state path' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$parsedDeploymentId = [Guid]::Empty
if ($DeploymentId -notmatch $UuidV4Pattern -or -not [Guid]::TryParseExact($DeploymentId, 'D', [ref]$parsedDeploymentId)) { throw 'DeploymentId must be a UUID v4' }
$DeploymentId = $parsedDeploymentId.ToString('D')
$statePath = [IO.Path]::Combine($StateRoot, "$DeploymentId.json")
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { [pscustomobject]@{ status = 'absent'; action = 'none'; deploymentId = $DeploymentId } | ConvertTo-Json -Compress; exit 0 }
$state = Read-StrictState $statePath $DeploymentId
$references = @($state.profileReferences)
foreach ($reference in $references) { $profileId = [Guid]::Empty; if ([string]$reference -notmatch $UuidV4Pattern -or -not [Guid]::TryParseExact([string]$reference, 'D', [ref]$profileId)) { throw 'Certificate state contains an invalid v4 profile reference' } }
if ($null -ne $state.selectedProfileId -and [string]$state.selectedProfileId -notin $references) { throw 'Selected profile is not a certificate reference' }
if ($references.Count -ne 0) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PROFILE_REFERENCES'; referenceCount = $references.Count; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }
if ($state.importedByProduct -ne $true) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PREEXISTING_CERTIFICATE'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }

$plan = [pscustomobject]@{ status = 'planned'; action = 'remove-if-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint }
if ($PlanOnly) { $plan | ConvertTo-Json -Compress; exit 0 }

if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot) -and -not $DevelopmentTestMode) { throw 'TestStoreRoot requires explicit DevelopmentTestMode' }
$lifecycleLock = Enter-LifecycleLock $StateRoot
try {
# Re-read while holding the shared lock so references and ownership cannot change before deletion.
$state = Read-StrictState $statePath $DeploymentId
if (@($state.profileReferences).Count -ne 0 -or $state.importedByProduct -ne $true) { throw 'Certificate state changed while waiting for lifecycle lock' }

if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot)) {
  $exactPath = [IO.Path]::Combine([IO.Path]::GetFullPath($TestStoreRoot), 'Root', "$($state.ownedThumbprint).cer")
  if (-not (Test-Path -LiteralPath $exactPath -PathType Leaf)) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }
  $fakeItem = Get-Item -LiteralPath $exactPath -Force
  if (($fakeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $fakeItem.Length -eq 0 -or $fakeItem.Length -gt 262144 -or (Get-Sha256 ([IO.File]::ReadAllBytes($exactPath))) -cne [string]$state.ownedThumbprint) {
    [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return
  }
  Remove-Item -LiteralPath $exactPath -Force
} else {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq [string]$state.ownedThumbprint })
    if ($exact.Count -ne 1) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }
    $store.Remove($exact[0])
  } finally { $store.Close() }
}
Remove-Item -LiteralPath $statePath -Force
[pscustomobject]@{ status = 'removed'; action = 'removed-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress
} finally {
  $lifecycleLock.Stream.Dispose()
  Remove-Item -LiteralPath $lifecycleLock.Path -Force -ErrorAction SilentlyContinue
}
