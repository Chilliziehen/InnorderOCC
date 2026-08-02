[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ReleaseManifestPath,
  [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedFingerprint,
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [ValidateSet('Production', 'Development')][string]$Mode = 'Production',
  [string]$InstallerPath,
  [string]$TestReleasePublicKeyPath,
  [string]$TestStoreRoot,
  [ValidateSet('', 'BeforeLockPublish', 'AfterJournal', 'AfterStore', 'AfterState')][string]$TestCrashPhase = '',
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
$UuidV4Pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
$LockStaleMilliseconds = 30000
$ProductionKeyN = 'x-emz8UzYUFQWLVF8Ud4X1lC_iC8w2LF0hupPJyKHSnKZB2Vu98yjK1Y8Hqv1dxasqx03r3RSGheXj_i-OVD8eqeZ6WCe13T5Kml38JGXgF0TEtSO0mQ-ToziCAoX4u_dCn3Hs_WV87JgqPFJXz5QJuyj8enSj3jATk6VSY9ceYjuxPkmqgO996gYnY_dS2LfXG7KkfZc3nTzEMbh1U-IQ6rEvTzzNDLpLGY9MhcsBewH2q7Mik4rWNV1LEbSVYefdfnpMRYkfoCZ6UMfAv9C9pdHYZzVRjWeRxOKb47chV6_yWQLbq0hilTYNT64ZiySC62Js4vWYnuksmqSnuCnNdORvLqCdhodWvdd49gAQNO3cdOIcr6yHogCG8LUdReglgQsd_1XgHl68dsFdOH2CG8-Ph-aeZ_eBv5XW8L3osh_ztOn_s26Ii4By00_-ITW83eagKCXW8FiXjZ5WVnGo2BCJPVVH4oHdFNEZdySgpi4bCSwbSebah9ILyPpvEH'
$ProductionKeyE = 'AQAB'
$ProductionKeyId = 'innorder-release-2026'

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

function ConvertFrom-Base64Url([string]$Value) {
  $base64 = $Value.Replace('-', '+').Replace('_', '/')
  while (($base64.Length % 4) -ne 0) { $base64 += '=' }
  return [Convert]::FromBase64String($base64)
}

function New-ReleaseRsa([string]$Modulus, [string]$Exponent) {
  $rsa = [Security.Cryptography.RSA]::Create()
  $parameters = New-Object Security.Cryptography.RSAParameters
  $parameters.Modulus = ConvertFrom-Base64Url $Modulus
  $parameters.Exponent = ConvertFrom-Base64Url $Exponent
  $rsa.ImportParameters($parameters)
  return $rsa
}

function ConvertFrom-Hex([string]$Value) {
  if ($Value -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Invalid SHA-256 hex value' }
  [byte[]]$result = New-Object byte[] 32
  for ($index = 0; $index -lt 32; $index++) { $result[$index] = [Convert]::ToByte($Value.Substring($index * 2, 2), 16) }
  return $result
}

function Enter-LifecycleLock([string]$Root) {
  $lockPath = [IO.Path]::Combine($Root, '.deployment-ca.lifecycle.lock')
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $temporaryPath = "$lockPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $staging = $null
    try {
      $owner = [Guid]::NewGuid().ToString('D')
      $record = [ordered]@{ version = 1; pid = $PID; processStartUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); acquiredAtUtc = [DateTime]::UtcNow.ToString('o'); owner = $owner }
      [byte[]]$bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
      $staging = [IO.FileStream]::new($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
      $staging.Write($bytes, 0, $bytes.Length); $staging.Flush($true); $staging.Dispose(); $staging = $null
      if ($TestCrashPhase -ceq 'BeforeLockPublish') { throw 'Simulated lock publication crash' }
      [IO.File]::Move($temporaryPath, $lockPath)
      $stream = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      [byte[]]$publishedBytes = New-Object byte[] $bytes.Length
      $publishedOffset = 0
      while ($publishedOffset -lt $publishedBytes.Length) { $read = $stream.Read($publishedBytes, $publishedOffset, $publishedBytes.Length - $publishedOffset); if ($read -eq 0) { break }; $publishedOffset += $read }
      if ($stream.Length -ne $bytes.Length -or $publishedOffset -ne $bytes.Length -or [Convert]::ToBase64String($publishedBytes) -cne [Convert]::ToBase64String($bytes)) { $stream.Dispose(); throw 'Published lifecycle lock owner mismatch' }
      $stream.Position = 0
      return [pscustomobject]@{ Stream = $stream; Path = $lockPath; Owner = $owner }
    } catch [IO.IOException] {
      try {
        $item = Get-Item -LiteralPath $lockPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and -not $item.PSIsContainer -and $item.Length -le 4096) {
          [byte[]]$observed = [IO.File]::ReadAllBytes($lockPath)
          $record = $null
          try { $record = [Text.Encoding]::UTF8.GetString($observed) | ConvertFrom-Json } catch { }
          $acquired = [DateTime]::MinValue; $started = [DateTime]::MinValue
          $valid = $null -ne $record -and (@($record.PSObject.Properties.Name | Sort-Object) -join '|') -ceq (@('acquiredAtUtc','owner','pid','processStartUtc','version') -join '|') -and $record.version -eq 1 -and $record.pid -is [int] -and $record.pid -gt 0 -and [string]$record.owner -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' -and [DateTime]::TryParse([string]$record.acquiredAtUtc, [ref]$acquired) -and [DateTime]::TryParse([string]$record.processStartUtc, [ref]$started)
          $stamp = if ($valid) { ([DateTime]::Parse([string]$record.acquiredAtUtc).ToUniversalTime()) } else { $item.LastWriteTimeUtc }
          if (([DateTime]::UtcNow - $stamp).TotalMilliseconds -ge $LockStaleMilliseconds) {
            $live = $false; $inspectionKnown = $false
            if ($valid) { try { $liveProcess = Get-Process -Id ([int]$record.pid) -ErrorAction Stop; $live = $liveProcess.StartTime.ToUniversalTime().ToString('o') -ceq [string]$record.processStartUtc; $inspectionKnown = $true } catch { if ($_.FullyQualifiedErrorId -match 'NoProcessFound') { $inspectionKnown = $true } } }
            else { $probe = $null; try { $probe = [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); $inspectionKnown = $true } catch { } finally { if ($null -ne $probe) { $probe.Dispose() } } }
            if ($inspectionKnown -and -not $live) {
              $stalePath = "$lockPath.stale.$([Guid]::NewGuid().ToString('N'))"
              [IO.File]::Move($lockPath, $stalePath)
              [byte[]]$moved = [IO.File]::ReadAllBytes($stalePath)
              if ([Convert]::ToBase64String($moved) -ceq [Convert]::ToBase64String($observed)) { [IO.File]::Delete($stalePath) }
              elseif (-not (Test-Path -LiteralPath $lockPath)) { [IO.File]::Move($stalePath, $lockPath) }
            }
          }
        }
      } catch { }
      Start-Sleep -Milliseconds 100
    } finally {
      if ($null -ne $staging) { $staging.Dispose() }
      if (Test-Path -LiteralPath $temporaryPath) { [IO.File]::Delete($temporaryPath) }
    }
  }
  throw 'Timed out acquiring deployment CA lifecycle lock'
}

function Exit-LifecycleLock($Lock) {
  $Lock.Stream.Dispose()
  try {
    $record = [IO.File]::ReadAllText($Lock.Path) | ConvertFrom-Json
    if ([string]$record.owner -ceq [string]$Lock.Owner) { [IO.File]::Delete($Lock.Path) }
  } catch { }
}

function Write-DurableBytes([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Write-AtomicText([string]$Path, [string]$Text) {
  $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  Write-DurableBytes $temporary ([Text.Encoding]::UTF8.GetBytes($Text))
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $backup = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).backup"
    [IO.File]::Replace($temporary, $Path, $backup); [IO.File]::Delete($backup)
  } else { [IO.File]::Move($temporary, $Path) }
}

function Test-StoreCertificate([string]$Thumbprint, [string]$FakeRoot) {
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) { return Test-Path -LiteralPath ([IO.Path]::Combine($FakeRoot, 'Root', "$Thumbprint.cer")) -PathType Leaf }
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadOnly')
  try { return @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $Thumbprint }).Count -eq 1 } finally { $store.Close() }
}

function Remove-StoreCertificate([string]$Thumbprint, [string]$FakeRoot) {
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) {
    $target = [IO.Path]::Combine($FakeRoot, 'Root', "$Thumbprint.cer")
    if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-Sha256 ([IO.File]::ReadAllBytes($target))) -ceq $Thumbprint) { [IO.File]::Delete($target) }
    return
  }
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadWrite')
  try { $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $Thumbprint }); if ($exact.Count -eq 1) { $store.Remove($exact[0]) } } finally { $store.Close() }
}

function Add-StoreCertificate([string]$Thumbprint, [string]$CertificateBase64, [string]$FakeRoot) {
  if (Test-StoreCertificate $Thumbprint $FakeRoot) { return }
  [byte[]]$raw = [Convert]::FromBase64String($CertificateBase64)
  if ((Get-Sha256 $raw) -cne $Thumbprint) { throw 'Journal certificate fingerprint mismatch' }
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) { $root = [IO.Path]::Combine($FakeRoot, 'Root'); [void][IO.Directory]::CreateDirectory($root); Write-DurableBytes ([IO.Path]::Combine($root, "$Thumbprint.cer")) $raw; return }
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($raw)
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadWrite')
  try { $store.Add($certificate) } finally { $store.Close(); $certificate.Dispose() }
}

function Recover-TransactionJournal([string]$JournalPath, [string]$StatePath, [string]$FakeRoot, [string]$ExpectedDeploymentId) {
  if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) { return }
  $journalItem = Get-Item -LiteralPath $JournalPath -Force
  if (($journalItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $journalItem.PSIsContainer -or $journalItem.Length -eq 0 -or $journalItem.Length -gt 524288) { throw 'Transaction journal must be a bounded regular file' }
  $journal = [IO.File]::ReadAllText($JournalPath) | ConvertFrom-Json
  Assert-ExactProperties $journal @('version','productId','deploymentId','operation','phase','action','thumbprint','priorStateBase64','priorImportedByProduct','storeHadCertificate','certificateBase64') 'Transaction journal'
  if ($journal.version -ne 1 -or $journal.productId -cne $ProductId -or $journal.deploymentId -cne $ExpectedDeploymentId -or [string]$journal.thumbprint -notmatch '^[0-9A-F]{64}$' -or [string]$journal.operation -notin @('enroll','remove') -or [string]$journal.phase -notin @('prepared','store-mutated','state-committed') -or $journal.priorImportedByProduct -isnot [bool] -or $journal.storeHadCertificate -isnot [bool]) { throw 'Invalid transaction journal' }
  [byte[]]$journalCertificate = [Convert]::FromBase64String([string]$journal.certificateBase64)
  if ($journalCertificate.Length -eq 0 -or $journalCertificate.Length -gt $MaximumCertificateBytes -or (Get-Sha256 $journalCertificate) -cne [string]$journal.thumbprint) { throw 'Invalid transaction journal certificate' }
  if ($null -ne $journal.priorStateBase64) {
    [byte[]]$priorStateBytes = [Convert]::FromBase64String([string]$journal.priorStateBase64)
    if ($priorStateBytes.Length -eq 0 -or $priorStateBytes.Length -gt $MaximumStateBytes) { throw 'Invalid transaction journal prior state' }
    $priorState = [Text.Encoding]::UTF8.GetString($priorStateBytes) | ConvertFrom-Json
    Assert-ExactProperties $priorState @('version','productId','deploymentId','importedByProduct','managed','ownedThumbprint','store','profileReferences','selectedProfileId') 'Transaction prior state'
    if ($priorState.productId -cne $ProductId -or $priorState.deploymentId -cne $ExpectedDeploymentId -or $priorState.ownedThumbprint -cne [string]$journal.thumbprint -or $priorState.importedByProduct -ne $journal.priorImportedByProduct) { throw 'Transaction prior state mismatch' }
  } elseif ($journal.priorImportedByProduct -ne $false) { throw 'Transaction prior ownership mismatch' }
  if ($journal.phase -cne 'state-committed') {
    if ($journal.operation -ceq 'enroll' -and $journal.storeHadCertificate -eq $false) { Remove-StoreCertificate ([string]$journal.thumbprint) $FakeRoot }
    if ($journal.operation -ceq 'remove') { Add-StoreCertificate ([string]$journal.thumbprint) ([string]$journal.certificateBase64) $FakeRoot }
    if ($null -eq $journal.priorStateBase64) { if (Test-Path -LiteralPath $StatePath) { [IO.File]::Delete($StatePath) } }
    else { Write-AtomicText $StatePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$journal.priorStateBase64))) }
  }
  [IO.File]::Delete($JournalPath)
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
  $item = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Target)) -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) { throw "$Label must be a regular non-reparse file" }
  return $item.FullName
}

function Test-PathUnder([string]$Root, [string]$Target) {
  $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  return $Target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

if (-not [IO.Path]::IsPathRooted($PayloadRoot)) { throw 'PayloadRoot must be absolute' }
$PayloadRoot = [IO.Path]::GetFullPath($PayloadRoot)
$rootItem = Get-Item -LiteralPath $PayloadRoot -Force
if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PayloadRoot must be a regular directory' }
$PayloadRoot = $rootItem.FullName
$ManifestPath = Assert-AbsoluteRegularPath $ManifestPath 'ManifestPath'
if (-not (Test-PathUnder $PayloadRoot $ManifestPath)) { throw 'ManifestPath must be under PayloadRoot' }
$ReleaseManifestPath = Assert-AbsoluteRegularPath $ReleaseManifestPath 'ReleaseManifestPath'
if (-not (Test-PathUnder $PayloadRoot $ReleaseManifestPath)) { throw 'ReleaseManifestPath must be under PayloadRoot' }
if (-not [IO.Path]::IsPathRooted($StateRoot) -or [IO.Path]::GetFileName([IO.Path]::GetFullPath($StateRoot).TrimEnd('\')) -cne 'state') { throw 'StateRoot must be an absolute product state path' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)

[byte[]]$manifestBytes = [IO.File]::ReadAllBytes($ManifestPath)
if ($manifestBytes.Length -eq 0 -or $manifestBytes.Length -gt $MaximumManifestBytes) { throw 'Manifest size exceeds the allowed bound' }
if ((Get-Sha256 $manifestBytes) -cne (ConvertTo-NormalizedSha256 $ExpectedManifestSha256 'ExpectedManifestSha256')) { throw 'Manifest SHA-256 mismatch' }
$manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
Assert-ExactProperties $manifest @('version', 'productId', 'deploymentId', 'certificate', 'releaseManifest') 'Manifest'
Assert-ExactProperties $manifest.certificate @('file', 'sha256', 'thumbprint', 'subject', 'dnsSans', 'ipSans', 'validFrom', 'validTo') 'Certificate metadata'
Assert-ExactProperties $manifest.releaseManifest.signature @('algorithm', 'keyId', 'value') 'Release signature metadata'
if ($manifest.version -ne 1 -or $manifest.productId -cne $ProductId) { throw 'Manifest product identity mismatch' }
$parsedDeploymentId = [Guid]::Empty
if ([string]$manifest.deploymentId -notmatch $UuidV4Pattern -or -not [Guid]::TryParseExact([string]$manifest.deploymentId, 'D', [ref]$parsedDeploymentId)) { throw 'Manifest deploymentId must be a UUID v4' }
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
Assert-ExactProperties $manifest.releaseManifest @('file', 'sha256', 'signature') 'Release manifest metadata'
if ([string]$manifest.releaseManifest.file -cne [IO.Path]::GetFileName($ReleaseManifestPath) -or [IO.Path]::GetFullPath([IO.Path]::Combine($PayloadRoot, [string]$manifest.releaseManifest.file)) -cne $ReleaseManifestPath) { throw 'Release manifest path mismatch' }
[byte[]]$releaseBytes = [IO.File]::ReadAllBytes($ReleaseManifestPath)
if ($releaseBytes.Length -eq 0 -or $releaseBytes.Length -gt $MaximumManifestBytes) { throw 'Release manifest size exceeds the allowed bound' }
$releaseDigest = Get-Sha256 $releaseBytes
if ($releaseDigest -cne (ConvertTo-NormalizedSha256 ([string]$manifest.releaseManifest.sha256) 'Release manifest sha256')) { throw 'Release manifest SHA-256 mismatch' }
if ([string]$manifest.releaseManifest.signature.algorithm -cne 'RSA-SHA256' -or [string]$manifest.releaseManifest.signature.keyId -notmatch '^[A-Za-z0-9._-]{1,128}$') { throw 'Invalid release signature metadata' }
[byte[]]$signatureBytes = [Convert]::FromBase64String([string]$manifest.releaseManifest.signature.value)
if ($signatureBytes.Length -lt 64 -or $signatureBytes.Length -gt 8192) { throw 'Invalid release signature size' }

$release = [Text.Encoding]::UTF8.GetString($releaseBytes) | ConvertFrom-Json
Assert-ExactProperties $release @('version', 'productId', 'productVersion', 'installer', 'helper', 'removalHelper', 'certificateManifest', 'publisher') 'Release manifest'
Assert-ExactProperties $release.installer @('file', 'sha256', 'productName', 'internalName') 'Release installer'
Assert-ExactProperties $release.helper @('file', 'sha256') 'Release helper'
Assert-ExactProperties $release.removalHelper @('file', 'sha256') 'Release removal helper'
Assert-ExactProperties $release.certificateManifest @('file', 'contentSha256') 'Release certificate manifest'
Assert-ExactProperties $release.publisher @('subject', 'thumbprint') 'Release publisher'
if ($release.version -ne 1 -or $release.productId -cne $ProductId -or [string]$release.productVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Release identity mismatch' }
$publisherThumbprint = ([string]$release.publisher.thumbprint).ToUpperInvariant()
if ([string]$release.installer.file -notmatch '^[^\\/:]{1,255}$' -or $release.helper.file -cne 'enroll-deployment-ca.ps1' -or $release.removalHelper.file -cne 'remove-deployment-ca.ps1' -or $release.certificateManifest.file -cne 'certificate-manifest.json' -or $publisherThumbprint -notmatch '^[0-9A-F]{40}$' -or [string]::IsNullOrWhiteSpace([string]$release.publisher.subject) -or ([string]$release.publisher.subject).Length -gt 4096) { throw 'Release manifest field validation failed' }
$helperItem = Get-Item -LiteralPath $PSCommandPath -Force
if (($helperItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $helperItem.Length -eq 0 -or $helperItem.Length -gt $MaximumCertificateBytes) { throw 'Enrollment helper must be a bounded regular non-reparse file' }
if ($release.helper.file -cne [IO.Path]::GetFileName($PSCommandPath) -or (Get-Sha256 ([IO.File]::ReadAllBytes($PSCommandPath))) -cne (ConvertTo-NormalizedSha256 ([string]$release.helper.sha256) 'Helper sha256')) { throw 'Enrollment helper binding mismatch' }
$removalHelperPath = Assert-AbsoluteRegularPath ([IO.Path]::Combine([IO.Path]::GetDirectoryName($PSCommandPath), [string]$release.removalHelper.file)) 'RemovalHelperPath'
if ((Get-Sha256 ([IO.File]::ReadAllBytes($removalHelperPath))) -cne (ConvertTo-NormalizedSha256 ([string]$release.removalHelper.sha256) 'Removal helper sha256')) { throw 'Removal helper binding mismatch' }
$InstallerPath = Assert-AbsoluteRegularPath $InstallerPath 'InstallerPath'
if ($InstallerPath -ceq $PSCommandPath) { throw 'Installer and helper paths must be distinct' }
$installerItem = Get-Item -LiteralPath $InstallerPath -Force
if ($installerItem.Length -eq 0 -or $installerItem.Length -gt 536870912) { throw 'Installer size exceeds the allowed bound' }
if ($release.installer.file -cne [IO.Path]::GetFileName($InstallerPath) -or (Get-Sha256 ([IO.File]::ReadAllBytes($InstallerPath))) -cne (ConvertTo-NormalizedSha256 ([string]$release.installer.sha256) 'Installer sha256')) { throw 'Installer binding mismatch' }
if ($release.installer.productName -cne 'Innorder OCC' -or $release.installer.internalName -cne 'InnorderOCC' -or $release.certificateManifest.file -cne [IO.Path]::GetFileName($ManifestPath)) { throw 'Signed product identity mismatch' }
$certificatePayload = [ordered]@{ version = 1; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; certificate = $manifest.certificate }
$contentBytes = [Text.Encoding]::UTF8.GetBytes(($certificatePayload | ConvertTo-Json -Compress -Depth 8))
if ((Get-Sha256 $contentBytes) -cne (ConvertTo-NormalizedSha256 ([string]$release.certificateManifest.contentSha256) 'Certificate manifest content sha256')) { throw 'Certificate manifest content binding mismatch' }

if ($Mode -eq 'Production' -and (-not [string]::IsNullOrWhiteSpace($TestReleasePublicKeyPath) -or -not [string]::IsNullOrWhiteSpace($TestStoreRoot))) { throw 'Production mode cannot redirect release keys or certificate stores' }
if (-not [string]::IsNullOrWhiteSpace($TestReleasePublicKeyPath) -and -not [IO.Path]::IsPathRooted($TestReleasePublicKeyPath)) { throw 'TestReleasePublicKeyPath must be absolute' }
if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot) -and -not [IO.Path]::IsPathRooted($TestStoreRoot)) { throw 'TestStoreRoot must be absolute' }
if ($Mode -eq 'Production') {
  $preflightHelperSignature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
  $preflightInstallerSignature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
  if ($preflightHelperSignature.Status -ne 'Valid' -or $preflightInstallerSignature.Status -ne 'Valid') {
    if ($PlanOnly) { [pscustomobject]@{ status = 'unavailable'; reason = 'AUTHENTICODE_REQUIRED'; action = 'none'; store = $StoreName } | ConvertTo-Json -Compress; exit 0 }
    throw 'Production enrollment requires signed helper and installer artifacts'
  }
  if ([string]$manifest.releaseManifest.signature.keyId -cne $ProductionKeyId) { throw 'Release signing key ID mismatch' }
}
$keyN = $ProductionKeyN; $keyE = $ProductionKeyE
if (-not [string]::IsNullOrWhiteSpace($TestReleasePublicKeyPath)) {
  if ($Mode -ne 'Development' -or (-not $PlanOnly -and [string]::IsNullOrWhiteSpace($TestStoreRoot))) { throw 'Test release key requires Development PlanOnly or fake-store mode' }
  $testKey = [IO.File]::ReadAllText((Assert-AbsoluteRegularPath $TestReleasePublicKeyPath 'TestReleasePublicKeyPath')) | ConvertFrom-Json
  Assert-ExactProperties $testKey @('n', 'e') 'Test release public key'
  $keyN = [string]$testKey.n; $keyE = [string]$testKey.e
}
$releaseRsa = New-ReleaseRsa $keyN $keyE
try {
  if (-not $releaseRsa.VerifyData((ConvertFrom-Hex $releaseDigest), $signatureBytes, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)) { throw 'Release manifest signature is invalid' }
} finally { $releaseRsa.Dispose() }

if ($Mode -eq 'Production') {
  $helperSignature = Get-AuthenticodeSignature -LiteralPath $PSCommandPath
  $installerSignature = Get-AuthenticodeSignature -LiteralPath $InstallerPath
  $publisherMatches = $helperSignature.SignerCertificate.Subject -ceq [string]$release.publisher.subject -and $installerSignature.SignerCertificate.Subject -ceq [string]$release.publisher.subject -and $helperSignature.SignerCertificate.Thumbprint -ceq $publisherThumbprint -and $installerSignature.SignerCertificate.Thumbprint -ceq $publisherThumbprint
  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerPath)
  if ($helperSignature.Status -ne 'Valid' -or $installerSignature.Status -ne 'Valid' -or -not $publisherMatches -or $versionInfo.ProductName -cne 'Innorder OCC' -or $versionInfo.InternalName -cne 'InnorderOCC' -or $versionInfo.ProductVersion -cne [string]$release.productVersion) {
    if ($PlanOnly) { [pscustomobject]@{ status = 'unavailable'; reason = 'AUTHENTICODE_REQUIRED'; action = 'none'; store = $StoreName } | ConvertTo-Json -Compress; exit 0 }
    throw 'Production enrollment requires valid Authenticode signatures on the helper and installer'
  }
}

$plan = [ordered]@{ status = 'planned'; action = 'import-if-absent'; store = $StoreName; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; ownedThumbprint = $fingerprint; statePath = [IO.Path]::Combine($StateRoot, "$($manifest.deploymentId).json") }
if ($PlanOnly) { [pscustomobject]$plan | ConvertTo-Json -Compress; exit 0 }
if (-not $InstallerConfirmed -and -not $PSCmdlet.ShouldContinue("Import deployment CA $fingerprint into $StoreName", 'Confirm deployment CA enrollment')) { throw 'Enrollment was not confirmed' }
if (-not [string]::IsNullOrWhiteSpace($TestCrashPhase) -and ($Mode -ne 'Development' -or [string]::IsNullOrWhiteSpace($TestStoreRoot))) { throw 'TestCrashPhase requires Development fake-store mode' }

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
$lifecycleLock = Enter-LifecycleLock $StateRoot
try {

$statePath = [string]$plan.statePath
$journalPath = [IO.Path]::Combine($StateRoot, ".deployment-ca.$($manifest.deploymentId).journal.json")
Recover-TransactionJournal $journalPath $statePath $TestStoreRoot ([string]$manifest.deploymentId)
$profileReferences = @()
$selectedProfileId = $null
$priorOwned = $false
$priorStateBase64 = $null
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
  $existingStateItem = Get-Item -LiteralPath $statePath -Force
  if (($existingStateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $existingStateItem.PSIsContainer -or $existingStateItem.Length -eq 0 -or $existingStateItem.Length -gt $MaximumStateBytes) { throw 'Existing certificate state must be a bounded regular non-reparse file' }
  $existing = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
  $priorStateBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath))
  Assert-ExactProperties $existing @('version', 'productId', 'deploymentId', 'importedByProduct', 'managed', 'ownedThumbprint', 'store', 'profileReferences', 'selectedProfileId') 'Existing certificate state'
  if ($existing.productId -cne $ProductId -or $existing.deploymentId -cne [string]$manifest.deploymentId -or $existing.ownedThumbprint -cne $fingerprint -or $existing.importedByProduct -isnot [bool] -or $existing.managed -isnot [bool] -or $existing.managed -ne $true -or $existing.store -cne $StoreName) { throw 'Existing certificate state ownership mismatch' }
  $priorOwned = $existing.importedByProduct -eq $true
  $profileReferences = @($existing.profileReferences)
  foreach ($reference in $profileReferences) { if ([string]$reference -notmatch $UuidV4Pattern) { throw 'Existing certificate state contains a non-v4 profile reference' } }
  $selectedProfileId = $existing.selectedProfileId
}

$imported = $false
$exactCount = 0
if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot)) {
  if ($Mode -ne 'Development') { throw 'TestStoreRoot is unavailable outside Development mode' }
  $fakeRoot = [IO.Path]::Combine([IO.Path]::GetFullPath($TestStoreRoot), 'Root')
  [void][IO.Directory]::CreateDirectory($fakeRoot)
  $exactPath = [IO.Path]::Combine($fakeRoot, "$fingerprint.cer")
  $fakeCertificates = @(Get-ChildItem -LiteralPath $fakeRoot -Filter '*.cer' -File | ForEach-Object { [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($_.FullName)) })
  $subjectCollision = @($fakeCertificates | Where-Object { $_.Subject -ceq $certificate.Subject -and (Get-Sha256 $_.RawData) -cne $fingerprint })
  if ($subjectCollision.Count -ne 0) { throw 'A different certificate with the same subject is already trusted' }
  if (Test-Path -LiteralPath $exactPath -PathType Leaf) { $exactCount = 1 }
} else {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
  try {
    $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $fingerprint })
    $exactCount = $exact.Count
    $subjectCollision = @($store.Certificates | Where-Object { $_.Subject -ceq $certificate.Subject -and (Get-Sha256 $_.RawData) -cne $fingerprint })
    if ($subjectCollision.Count -ne 0) { throw 'A different certificate with the same subject is already trusted' }
  } finally { $store.Close() }
}

$journal = [ordered]@{ version = 1; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; operation = 'enroll'; phase = 'prepared'; action = $(if ($exactCount -eq 0) { 'import' } else { 'state-only' }); thumbprint = $fingerprint; priorStateBase64 = $priorStateBase64; priorImportedByProduct = $priorOwned; storeHadCertificate = $exactCount -eq 1; certificateBase64 = [Convert]::ToBase64String($certificate.RawData) }
Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterJournal') { throw 'Simulated crash after journal' }
if ($exactCount -eq 0) { Add-StoreCertificate $fingerprint ([string]$journal.certificateBase64) $TestStoreRoot; $imported = $true }
$journal.phase = 'store-mutated'; Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterStore') { throw 'Simulated crash after store mutation' }
$owned = $priorOwned -or $imported
$state = [ordered]@{ version = 1; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; importedByProduct = $owned; managed = $true; ownedThumbprint = $fingerprint; store = $StoreName; profileReferences = $profileReferences; selectedProfileId = $selectedProfileId }
Write-AtomicText $statePath ($state | ConvertTo-Json -Compress)
$journal.phase = 'state-committed'; Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterState') { throw 'Simulated crash after state commit' }
[IO.File]::Delete($journalPath)
[pscustomobject]@{ status = 'enrolled'; action = $(if ($imported) { 'imported' } else { 'already-present' }); importedByProduct = $owned; store = $StoreName; productId = $ProductId; deploymentId = [string]$manifest.deploymentId; ownedThumbprint = $fingerprint } | ConvertTo-Json -Compress
} finally {
  Exit-LifecycleLock $lifecycleLock
}
