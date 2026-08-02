[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedFingerprint,
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [ValidateSet('Production', 'Development')][string]$Mode = 'Production',
  [string]$InstallerPath,
  [switch]$InstallerConfirmed,
  [switch]$PlanOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProductId = 'com.innorder.occ'
$StoreName = 'CurrentUser\Root'
$MaximumManifestBytes = 65536
$MaximumCertificateBytes = 262144
$MaximumStateBytes = 65536

function ConvertTo-NormalizedSha256([string]$Value, [string]$Label) {
  $normalized = $Value.Replace(':', '').ToUpperInvariant()
  if ($normalized -notmatch '^[0-9A-F]{64}$') { throw "$Label must be an exact SHA-256 value" }
  return $normalized
}

function Get-Sha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '') }
  finally { $algorithm.Dispose() }
}

function Assert-ExactProperties($Value, [string[]]$Names, [string]$Label) {
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join '|') -cne ($expected -join '|')) { throw "$Label has unknown or missing properties" }
}

function Get-DerHeader([byte[]]$Bytes, [int]$Offset, [int]$Limit) {
  if ($Offset + 2 -gt $Limit) { throw 'Truncated SAN extension' }
  $tag = [int]$Bytes[$Offset]
  $firstLength = [int]$Bytes[$Offset + 1]
  $contentStart = $Offset + 2
  if (($firstLength -band 0x80) -eq 0) { $length = $firstLength }
  else {
    $lengthBytes = $firstLength -band 0x7f
    if ($lengthBytes -eq 0 -or $lengthBytes -gt 4 -or $contentStart + $lengthBytes -gt $Limit) { throw 'Invalid SAN extension length' }
    $length = 0
    for ($index = 0; $index -lt $lengthBytes; $index++) { $length = ($length * 256) + $Bytes[$contentStart + $index] }
    if ($length -lt 128) { throw 'Non-canonical SAN extension length' }
    $contentStart += $lengthBytes
  }
  $contentEnd = $contentStart + $length
  if ($contentEnd -gt $Limit) { throw 'Truncated SAN extension value' }
  return [pscustomobject]@{ Tag = $tag; ContentStart = $contentStart; ContentEnd = $contentEnd; Next = $contentEnd }
}

function Get-CertificateSans([Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
  $extension = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' })
  if ($extension.Count -eq 0) { return [pscustomobject]@{ Dns = @(); Ip = @() } }
  if ($extension.Count -ne 1) { throw 'Duplicate SAN extension' }
  [byte[]]$bytes = $extension[0].RawData
  $sequence = Get-DerHeader $bytes 0 $bytes.Length
  if ($sequence.Tag -ne 0x30 -or $sequence.Next -ne $bytes.Length) { throw 'Invalid SAN extension' }
  $dns = @()
  $ip = @()
  $offset = $sequence.ContentStart
  while ($offset -lt $sequence.ContentEnd) {
    $name = Get-DerHeader $bytes $offset $sequence.ContentEnd
    [byte[]]$value = $bytes[$name.ContentStart..($name.ContentEnd - 1)]
    if ($name.Tag -eq 0x82) {
      if (@($value | Where-Object { $_ -lt 0x21 -or $_ -gt 0x7e }).Count -ne 0) { throw 'Invalid DNS SAN encoding' }
      $dns += [Text.Encoding]::ASCII.GetString($value).ToLowerInvariant()
    } elseif ($name.Tag -eq 0x87) {
      if ($value.Length -ne 4 -and $value.Length -ne 16) { throw 'Invalid IP SAN encoding' }
      $ip += ([Net.IPAddress]::new($value)).ToString().ToLowerInvariant()
    }
    $offset = $name.Next
  }
  return [pscustomobject]@{ Dns = $dns; Ip = $ip }
}

function Assert-AbsoluteRegularPath([string]$Target, [string]$Label) {
  if (-not [IO.Path]::IsPathRooted($Target)) { throw "$Label must be absolute" }
  $item = Get-Item -LiteralPath $Target -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { throw "$Label must be a regular non-reparse file" }
  return $item.FullName
}

function Test-PathUnder([string]$Root, [string]$Target) {
  $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  return $Target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

$PayloadRoot = [IO.Path]::GetFullPath($PayloadRoot)
if (-not [IO.Path]::IsPathRooted($PayloadRoot)) { throw 'PayloadRoot must be absolute' }
$rootItem = Get-Item -LiteralPath $PayloadRoot -Force
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PayloadRoot must be a regular directory' }
$PayloadRoot = $rootItem.FullName
$ManifestPath = Assert-AbsoluteRegularPath ([IO.Path]::GetFullPath($ManifestPath)) 'ManifestPath'
if (-not (Test-PathUnder $PayloadRoot $ManifestPath)) { throw 'ManifestPath must be under PayloadRoot' }
if (-not [IO.Path]::IsPathRooted($StateRoot) -or [IO.Path]::GetFileName([IO.Path]::GetFullPath($StateRoot).TrimEnd('\')) -cne 'state') { throw 'StateRoot must be an absolute product state path' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)

[byte[]]$manifestBytes = [IO.File]::ReadAllBytes($ManifestPath)
if ($manifestBytes.Length -eq 0 -or $manifestBytes.Length -gt $MaximumManifestBytes) { throw 'Manifest size exceeds the allowed bound' }
if ((Get-Sha256 $manifestBytes) -cne (ConvertTo-NormalizedSha256 $ExpectedManifestSha256 'ExpectedManifestSha256')) { throw 'Manifest SHA-256 mismatch' }
$manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
Assert-ExactProperties $manifest @('version', 'productId', 'deploymentId', 'certificate', 'releaseManifest') 'Manifest'
Assert-ExactProperties $manifest.certificate @('file', 'sha256', 'thumbprint', 'subject', 'dnsSans', 'ipSans', 'validFrom', 'validTo') 'Certificate metadata'
Assert-ExactProperties $manifest.releaseManifest @('sha256', 'signature') 'Release manifest metadata'
Assert-ExactProperties $manifest.releaseManifest.signature @('algorithm', 'keyId', 'value') 'Release signature metadata'
if ($manifest.version -ne 1 -or $manifest.productId -cne $ProductId) { throw 'Manifest product identity mismatch' }
$parsedDeploymentId = [Guid]::Empty
if (-not [Guid]::TryParseExact([string]$manifest.deploymentId, 'D', [ref]$parsedDeploymentId)) { throw 'Manifest deploymentId must be a UUID' }
if ([string]$manifest.certificate.file -in @('.', '..') -or [string]$manifest.certificate.file -notmatch '^[^\\/:]{1,255}$') { throw 'Certificate file must be a relative basename without ADS' }
$certificatePath = Assert-AbsoluteRegularPath ([IO.Path]::Combine($PayloadRoot, [string]$manifest.certificate.file)) 'CertificatePath'
if (-not (Test-PathUnder $PayloadRoot $certificatePath)) { throw 'CertificatePath must remain under PayloadRoot' }
[byte[]]$certificateFileBytes = [IO.File]::ReadAllBytes($certificatePath)
if ($certificateFileBytes.Length -eq 0 -or $certificateFileBytes.Length -gt $MaximumCertificateBytes) { throw 'Certificate size exceeds the allowed bound' }
if ((Get-Sha256 $certificateFileBytes) -cne (ConvertTo-NormalizedSha256 ([string]$manifest.certificate.sha256) 'Certificate sha256')) { throw 'Certificate file SHA-256 mismatch' }

$certificateText = [Text.Encoding]::ASCII.GetString($certificateFileBytes)
if ($certificateText -match '-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----') { throw 'Private key PEM is forbidden' }
if ($certificateText.StartsWith('-----BEGIN')) {
  $match = [regex]::Match($certificateText, '\A-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?\z')
  if (-not $match.Success) { throw 'Certificate PEM must contain exactly one certificate with no trailing data' }
  $base64 = $match.Groups[1].Value -replace '\r?\n', ''
  [byte[]]$certificateDer = [Convert]::FromBase64String($base64)
  if ([Convert]::ToBase64String($certificateDer) -cne $base64) { throw 'Certificate PEM is not canonical' }
} else { [byte[]]$certificateDer = $certificateFileBytes }
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificateDer)
if ($certificate.RawData.Length -ne $certificateDer.Length -or (Get-Sha256 $certificate.RawData) -cne (Get-Sha256 $certificateDer)) { throw 'Certificate DER contains trailing data' }

$basicConstraints = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
$keyUsage = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.15' })
if ($basicConstraints.Count -ne 1 -or $keyUsage.Count -ne 1) { throw 'CA constraints and key usage are required' }
$basic = [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($basicConstraints[0], $basicConstraints[0].Critical)
$usage = [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage[0], $keyUsage[0].Critical)
if (-not $basic.CertificateAuthority -or ($usage.KeyUsages -band [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign) -eq 0) { throw 'Certificate must be a CA with keyCertSign' }

$fingerprint = Get-Sha256 $certificate.RawData
if ($fingerprint -cne (ConvertTo-NormalizedSha256 ([string]$manifest.certificate.thumbprint) 'Manifest thumbprint') -or $fingerprint -cne (ConvertTo-NormalizedSha256 $ExpectedFingerprint 'ExpectedFingerprint')) { throw 'Certificate fingerprint mismatch' }
$canonicalSubject = $certificate.SubjectName.Decode([Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines).Replace("`r`n", "`n")
if ($canonicalSubject -cne [string]$manifest.certificate.subject) { throw 'Certificate subject mismatch' }
$validFrom = $certificate.NotBefore.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
$validTo = $certificate.NotAfter.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
if ($validFrom -cne [string]$manifest.certificate.validFrom -or $validTo -cne [string]$manifest.certificate.validTo) { throw 'Certificate validity metadata mismatch' }
$now = [DateTime]::UtcNow
if ($now -lt $certificate.NotBefore.ToUniversalTime() -or $now -gt $certificate.NotAfter.ToUniversalTime()) { throw 'Certificate is not currently valid' }
$sans = Get-CertificateSans $certificate
if (($sans.Dns -join '|') -cne (@($manifest.certificate.dnsSans | ForEach-Object { ([string]$_).ToLowerInvariant() }) -join '|') -or ($sans.Ip -join '|') -cne (@($manifest.certificate.ipSans | ForEach-Object { ([Net.IPAddress]::Parse([string]$_)).ToString().ToLowerInvariant() }) -join '|')) { throw 'Certificate SAN metadata mismatch' }
[void](ConvertTo-NormalizedSha256 ([string]$manifest.releaseManifest.sha256) 'Release manifest sha256')
if ([string]$manifest.releaseManifest.signature.algorithm -notin @('RSA-SHA256', 'ECDSA-SHA256', 'Ed25519') -or [string]$manifest.releaseManifest.signature.keyId -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'Invalid release signature metadata' }
[byte[]]$signatureBytes = [Convert]::FromBase64String([string]$manifest.releaseManifest.signature.value)
if ($signatureBytes.Length -lt 64 -or $signatureBytes.Length -gt 8192) { throw 'Invalid release signature size' }

if ($Mode -eq 'Production') {
  $helperSignature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
  $installerSignatureValid = $false
  if ($helperSignature.Status -eq 'Valid' -and -not [string]::IsNullOrWhiteSpace($InstallerPath) -and [IO.Path]::IsPathRooted($InstallerPath)) {
    $resolvedInstaller = Assert-AbsoluteRegularPath ([IO.Path]::GetFullPath($InstallerPath)) 'InstallerPath'
    if (Test-PathUnder $PayloadRoot $resolvedInstaller) { $installerSignatureValid = (Get-AuthenticodeSignature -LiteralPath $resolvedInstaller).Status -eq 'Valid' }
  }
  if ($helperSignature.Status -ne 'Valid' -or -not $installerSignatureValid) {
    if ($PlanOnly) { [pscustomobject]@{ status = 'unavailable'; reason = 'AUTHENTICODE_REQUIRED'; action = 'none'; store = $StoreName } | ConvertTo-Json -Compress; exit 0 }
    throw 'Production enrollment requires valid Authenticode signatures on the helper and installer'
  }
}

$plan = [ordered]@{ status = 'planned'; action = 'import-if-absent'; store = $StoreName; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; ownedThumbprint = $fingerprint; statePath = [IO.Path]::Combine($StateRoot, "$($manifest.deploymentId).json") }
if ($PlanOnly) { [pscustomobject]$plan | ConvertTo-Json -Compress; exit 0 }
if (-not $InstallerConfirmed -and -not $PSCmdlet.ShouldContinue("Import deployment CA $fingerprint into $StoreName", 'Confirm deployment CA enrollment')) { throw 'Enrollment was not confirmed' }

if (-not (Test-Path -LiteralPath $StateRoot)) { [void][IO.Directory]::CreateDirectory($StateRoot) }
$stateDirectory = Get-Item -LiteralPath $StateRoot -Force
if (-not $stateDirectory.PSIsContainer -or ($stateDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'StateRoot must be a regular directory' }
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$directorySecurity = New-Object Security.AccessControl.DirectorySecurity
$directorySecurity.SetOwner($currentIdentity.User)
$directorySecurity.SetAccessRuleProtection($true, $false)
$directoryRule = New-Object Security.AccessControl.FileSystemAccessRule($currentIdentity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$directorySecurity.AddAccessRule($directoryRule)
[IO.Directory]::SetAccessControl($StateRoot, $directorySecurity)

$statePath = [string]$plan.statePath
$profileReferences = @()
$selectedProfileId = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
  $existingStateItem = Get-Item -LiteralPath $statePath -Force
  if (($existingStateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $existingStateItem.PSIsContainer -or $existingStateItem.Length -eq 0 -or $existingStateItem.Length -gt $MaximumStateBytes) { throw 'Existing certificate state must be a bounded regular non-reparse file' }
  $existing = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
  Assert-ExactProperties $existing @('version', 'productId', 'deploymentId', 'importedByProduct', 'ownedThumbprint', 'store', 'profileReferences', 'selectedProfileId') 'Existing certificate state'
  if ($existing.productId -cne $ProductId -or $existing.deploymentId -cne [string]$manifest.deploymentId -or $existing.ownedThumbprint -cne $fingerprint -or $existing.importedByProduct -ne $true -or $existing.store -cne $StoreName) { throw 'Existing certificate state ownership mismatch' }
  $profileReferences = @($existing.profileReferences)
  $selectedProfileId = $existing.selectedProfileId
}

$imported = $false
$store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
try {
  $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $fingerprint })
  $subjectCollision = @($store.Certificates | Where-Object { $_.Subject -ceq $certificate.Subject -and (Get-Sha256 $_.RawData) -cne $fingerprint })
  if ($subjectCollision.Count -ne 0) { throw 'A different certificate with the same subject is already trusted' }
  if ($exact.Count -eq 0) { $store.Add($certificate); $imported = $true }
} finally { $store.Close() }

$state = [ordered]@{ version = 1; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; importedByProduct = $true; ownedThumbprint = $fingerprint; store = $StoreName; profileReferences = $profileReferences; selectedProfileId = $selectedProfileId }
$temporaryState = "$statePath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
try {
  [IO.File]::WriteAllText($temporaryState, ($state | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $statePath -PathType Leaf) { [IO.File]::Replace($temporaryState, $statePath, $null) }
  else { [IO.File]::Move($temporaryState, $statePath) }
} catch {
  if (Test-Path -LiteralPath $temporaryState -PathType Leaf) { Remove-Item -LiteralPath $temporaryState -Force }
  if ($imported) {
    $rollbackStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    $rollbackStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
      $rollbackExact = @($rollbackStore.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $fingerprint })
      if ($rollbackExact.Count -eq 1) { $rollbackStore.Remove($rollbackExact[0]) }
    } finally { $rollbackStore.Close() }
  }
  throw
}
[pscustomobject]@{ status = 'enrolled'; action = $(if ($exact.Count -eq 0) { 'imported' } else { 'already-present' }); store = $StoreName; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; ownedThumbprint = $fingerprint } | ConvertTo-Json -Compress
