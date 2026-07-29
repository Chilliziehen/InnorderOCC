$ErrorActionPreference = "Stop"

$candidates = [System.Collections.Generic.List[string]]::new()

function Add-Candidate([string] $javaHome) {
    if ($javaHome -and -not $candidates.Contains($javaHome)) {
        $candidates.Add($javaHome)
    }
}

Add-Candidate $env:GRADLE_JAVA_HOME
Add-Candidate $env:JAVA_HOME

$pathJava = Get-Command java.exe -ErrorAction SilentlyContinue
if ($pathJava) {
    Add-Candidate (Split-Path (Split-Path $pathJava.Source -Parent) -Parent)
}

function Add-DirectChildren([string] $root) {
    if (-not $root) {
        return
    }
    try {
        if (-not (Test-Path -LiteralPath $root)) {
            return
        }
        foreach ($directory in [System.IO.Directory]::EnumerateDirectories($root)) {
            Add-Candidate $directory
        }
    } catch {
        # An inaccessible optional install root must not prevent checking others.
    }
}

function Add-GradleProvisionedJdks([string] $root) {
    if (-not $root) {
        return
    }
    try {
        if (-not (Test-Path -LiteralPath $root)) {
            return
        }
        foreach ($directory in [System.IO.Directory]::EnumerateDirectories($root)) {
            if (Test-Path -LiteralPath (Join-Path $directory "provisioned.ok")) {
                Add-Candidate $directory
            }
        }
    } catch {
        # Ignore inaccessible Gradle cache entries and continue with installed JDKs.
    }
}

Add-GradleProvisionedJdks (Join-Path $env:USERPROFILE ".gradle\jdks")
Add-DirectChildren (Join-Path $env:ProgramFiles "Java")
Add-DirectChildren (Join-Path $env:ProgramFiles "Eclipse Adoptium")
Add-DirectChildren (Join-Path $env:ProgramFiles "Microsoft")
Add-DirectChildren (Join-Path $env:LOCALAPPDATA "Programs\Eclipse Adoptium")
Add-DirectChildren (Join-Path $env:USERPROFILE ".jdks")

$jetBrainsRoot = Join-Path $env:ProgramFiles "JetBrains"
try {
    if (Test-Path -LiteralPath $jetBrainsRoot) {
        foreach ($product in [System.IO.Directory]::EnumerateDirectories($jetBrainsRoot)) {
            Add-Candidate (Join-Path $product "jbr")
        }
    }
} catch {
    # JetBrains runtimes are optional fallbacks.
}

foreach ($javaHome in $candidates) {
    try {
        $java = Join-Path $javaHome "bin\java.exe"
        if (-not (Test-Path -LiteralPath $java)) {
            continue
        }

        $ErrorActionPreference = "Continue"
        $versionLine = (& $java -version 2>&1 | Select-Object -First 1).ToString()
        $ErrorActionPreference = "Stop"
    } catch {
        $ErrorActionPreference = "Stop"
        continue
    }
    if ($versionLine -match 'version "(?:1\.)?(\d+)') {
        $major = [int] $Matches[1]
        if ($major -ge 17 -and $major -le 24) {
            $javaHome
            exit 0
        }
    }
}

[Console]::Error.WriteLine("No supported fallback was found. Set JAVA_HOME to a Java 21-24 JDK.")
exit 1
