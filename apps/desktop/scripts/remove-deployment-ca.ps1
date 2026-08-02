[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [Parameter(Mandatory = $true)][string]$DeploymentId,
  [string]$TestStoreRoot,
  [switch]$DevelopmentTestMode,
  [ValidateSet('', 'AfterJournal', 'AfterStore', 'AfterState')][string]$TestCrashPhase = '',
  [switch]$PlanOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProductId = 'com.innorder.occ'
$StoreName = 'CurrentUser\Root'
$MaximumStateBytes = 65536
$UuidV4Pattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
$LockStaleMilliseconds = 30000

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
    try {
      $stream = [IO.File]::Open($lockPath, 'CreateNew', 'ReadWrite', 'None')
      $owner = [Guid]::NewGuid().ToString('D')
      $record = [ordered]@{ version = 1; pid = $PID; processStartUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o'); acquiredAtUtc = [DateTime]::UtcNow.ToString('o'); owner = $owner }
      [byte[]]$bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
      $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
      return [pscustomobject]@{ Stream = $stream; Path = $lockPath; Owner = $owner }
    } catch [IO.IOException] {
      try {
        $item = Get-Item -LiteralPath $lockPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and -not $item.PSIsContainer -and $item.Length -le 4096) {
          [byte[]]$observed = [IO.File]::ReadAllBytes($lockPath); $record = $null
          try { $record = [Text.Encoding]::UTF8.GetString($observed) | ConvertFrom-Json } catch { }
          $acquired = [DateTime]::MinValue; $started = [DateTime]::MinValue
          $valid = $null -ne $record -and (@($record.PSObject.Properties.Name | Sort-Object) -join '|') -ceq (@('acquiredAtUtc','owner','pid','processStartUtc','version') -join '|') -and $record.version -eq 1 -and $record.pid -is [int] -and $record.pid -gt 0 -and [string]$record.owner -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' -and [DateTime]::TryParse([string]$record.acquiredAtUtc, [ref]$acquired) -and [DateTime]::TryParse([string]$record.processStartUtc, [ref]$started)
          if ($valid -and ([DateTime]::UtcNow - ([DateTime]::Parse([string]$record.acquiredAtUtc).ToUniversalTime())).TotalMilliseconds -ge $LockStaleMilliseconds) {
            $live = $false; $inspectionKnown = $false
            try { $liveProcess = Get-Process -Id ([int]$record.pid) -ErrorAction Stop; $live = $liveProcess.StartTime.ToUniversalTime().ToString('o') -ceq [string]$record.processStartUtc; $inspectionKnown = $true } catch { if ($_.FullyQualifiedErrorId -match 'NoProcessFound') { $inspectionKnown = $true } }
            if ($inspectionKnown -and -not $live) {
              $stalePath = "$lockPath.stale.$([Guid]::NewGuid().ToString('N'))"; [IO.File]::Move($lockPath, $stalePath)
              [byte[]]$moved = [IO.File]::ReadAllBytes($stalePath)
              if ([Convert]::ToBase64String($moved) -ceq [Convert]::ToBase64String($observed)) { [IO.File]::Delete($stalePath) }
              elseif (-not (Test-Path -LiteralPath $lockPath)) { [IO.File]::Move($stalePath, $lockPath) }
            }
          }
        }
      } catch { }
      Start-Sleep -Milliseconds 100
    }
  }
  throw 'Timed out acquiring deployment CA lifecycle lock'
}

function Exit-LifecycleLock($Lock) {
  $Lock.Stream.Dispose()
  try { $record = [IO.File]::ReadAllText($Lock.Path) | ConvertFrom-Json; if ([string]$record.owner -ceq [string]$Lock.Owner) { [IO.File]::Delete($Lock.Path) } } catch { }
}

function Write-DurableBytes([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Write-AtomicText([string]$Path, [string]$Text) {
  $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"; Write-DurableBytes $temporary ([Text.Encoding]::UTF8.GetBytes($Text))
  if (Test-Path -LiteralPath $Path -PathType Leaf) { $backup = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).backup"; [IO.File]::Replace($temporary, $Path, $backup); [IO.File]::Delete($backup) }
  else { [IO.File]::Move($temporary, $Path) }
}

function Test-StoreCertificate([string]$Thumbprint, [string]$FakeRoot) {
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) { return Test-Path -LiteralPath ([IO.Path]::Combine($FakeRoot, 'Root', "$Thumbprint.cer")) -PathType Leaf }
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadOnly')
  try { return @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $Thumbprint }).Count -eq 1 } finally { $store.Close() }
}

function Remove-StoreCertificate([string]$Thumbprint, [string]$FakeRoot) {
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) { $target = [IO.Path]::Combine($FakeRoot, 'Root', "$Thumbprint.cer"); if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-Sha256 ([IO.File]::ReadAllBytes($target))) -ceq $Thumbprint) { [IO.File]::Delete($target) }; return }
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadWrite')
  try { $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq $Thumbprint }); if ($exact.Count -eq 1) { $store.Remove($exact[0]) } } finally { $store.Close() }
}

function Add-StoreCertificate([string]$Thumbprint, [string]$CertificateBase64, [string]$FakeRoot) {
  if (Test-StoreCertificate $Thumbprint $FakeRoot) { return }
  [byte[]]$raw = [Convert]::FromBase64String($CertificateBase64); if ((Get-Sha256 $raw) -cne $Thumbprint) { throw 'Journal certificate fingerprint mismatch' }
  if (-not [string]::IsNullOrWhiteSpace($FakeRoot)) { $root = [IO.Path]::Combine($FakeRoot, 'Root'); [void][IO.Directory]::CreateDirectory($root); Write-DurableBytes ([IO.Path]::Combine($root, "$Thumbprint.cer")) $raw; return }
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($raw); $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser'); $store.Open('ReadWrite')
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
  if ($journalCertificate.Length -eq 0 -or $journalCertificate.Length -gt 262144 -or (Get-Sha256 $journalCertificate) -cne [string]$journal.thumbprint) { throw 'Invalid transaction journal certificate' }
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
if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot) -and -not $DevelopmentTestMode) { throw 'TestStoreRoot requires explicit DevelopmentTestMode' }
if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot) -and -not [IO.Path]::IsPathRooted($TestStoreRoot)) { throw 'TestStoreRoot must be absolute' }
if (-not [string]::IsNullOrWhiteSpace($TestCrashPhase) -and (-not $DevelopmentTestMode -or [string]::IsNullOrWhiteSpace($TestStoreRoot))) { throw 'TestCrashPhase requires Development fake-store mode' }
if ($PlanOnly) {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { [pscustomobject]@{ status = 'absent'; action = 'none'; deploymentId = $DeploymentId } | ConvertTo-Json -Compress; exit 0 }
  $state = Read-StrictState $statePath $DeploymentId; $references = @($state.profileReferences)
  if ($references.Count -ne 0) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PROFILE_REFERENCES'; referenceCount = $references.Count; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }
  if ($state.importedByProduct -ne $true) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PREEXISTING_CERTIFICATE'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0 }
  [pscustomobject]@{ status = 'planned'; action = 'remove-if-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; exit 0
}
$lifecycleLock = Enter-LifecycleLock $StateRoot
try {
$journalPath = [IO.Path]::Combine($StateRoot, ".deployment-ca.$DeploymentId.journal.json")
Recover-TransactionJournal $journalPath $statePath $TestStoreRoot $DeploymentId
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { [pscustomobject]@{ status = 'absent'; action = 'none'; deploymentId = $DeploymentId } | ConvertTo-Json -Compress; return }
$state = Read-StrictState $statePath $DeploymentId
$references = @($state.profileReferences)
foreach ($reference in $references) { $profileId = [Guid]::Empty; if ([string]$reference -notmatch $UuidV4Pattern -or -not [Guid]::TryParseExact([string]$reference, 'D', [ref]$profileId)) { throw 'Certificate state contains an invalid v4 profile reference' } }
if ($null -ne $state.selectedProfileId -and [string]$state.selectedProfileId -notin $references) { throw 'Selected profile is not a certificate reference' }
if ($references.Count -ne 0) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PROFILE_REFERENCES'; referenceCount = $references.Count; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }
if ($state.importedByProduct -ne $true) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'PREEXISTING_CERTIFICATE'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }

if (-not [string]::IsNullOrWhiteSpace($TestStoreRoot)) {
  $exactPath = [IO.Path]::Combine([IO.Path]::GetFullPath($TestStoreRoot), 'Root', "$($state.ownedThumbprint).cer")
  if (-not (Test-Path -LiteralPath $exactPath -PathType Leaf)) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }
  $fakeItem = Get-Item -LiteralPath $exactPath -Force
  if (($fakeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $fakeItem.Length -eq 0 -or $fakeItem.Length -gt 262144 -or (Get-Sha256 ([IO.File]::ReadAllBytes($exactPath))) -cne [string]$state.ownedThumbprint) {
    [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return
  }
  [byte[]]$certificateRaw = [IO.File]::ReadAllBytes($exactPath)
} else {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
  $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    $exact = @($store.Certificates | Where-Object { (Get-Sha256 $_.RawData) -ceq [string]$state.ownedThumbprint })
    if ($exact.Count -ne 1) { [pscustomobject]@{ status = 'retained'; action = 'none'; reason = 'STORE_EXACT_MATCH_REQUIRED'; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress; return }
    [byte[]]$certificateRaw = $exact[0].RawData
  } finally { $store.Close() }
}
$journal = [ordered]@{ version = 1; productId = $ProductId; deploymentId = $DeploymentId; operation = 'remove'; phase = 'prepared'; action = 'remove-owned'; thumbprint = [string]$state.ownedThumbprint; priorStateBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath)); priorImportedByProduct = $true; storeHadCertificate = $true; certificateBase64 = [Convert]::ToBase64String($certificateRaw) }
Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterJournal') { throw 'Simulated crash after journal' }
Remove-StoreCertificate ([string]$state.ownedThumbprint) $TestStoreRoot
$journal.phase = 'store-mutated'; Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterStore') { throw 'Simulated crash after store mutation' }
[IO.File]::Delete($statePath)
$journal.phase = 'state-committed'; Write-AtomicText $journalPath ($journal | ConvertTo-Json -Compress)
if ($TestCrashPhase -ceq 'AfterState') { throw 'Simulated crash after state commit' }
[IO.File]::Delete($journalPath)
[pscustomobject]@{ status = 'removed'; action = 'removed-exact-match'; store = $StoreName; productId = $ProductId; deploymentId = $DeploymentId; ownedThumbprint = [string]$state.ownedThumbprint } | ConvertTo-Json -Compress
} finally {
  Exit-LifecycleLock $lifecycleLock
}
