Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot/dev.ps1"

$failures = New-Object System.Collections.Generic.List[string]

function Assert-Equal {
    param(
        [string]$Name,
        $Actual,
        $Expected
    )
    if ($Actual -ne $Expected) {
        $failures.Add("$Name expected '$Expected' but got '$Actual'")
    } else {
        Write-Host "PASS: $Name"
    }
}

function Assert-True {
    param([string]$Name, [bool]$Condition)
    if (-not $Condition) {
        $failures.Add("$Name expected True but got False")
    } else {
        Write-Host "PASS: $Name"
    }
}

# Test: platform detection does not rely on PS7-only automatic variables.
$oldOS = $env:OS
$env:OS = 'Windows_NT'
Assert-Equal -Name 'Get-PlatformName windows' -Actual (Get-PlatformName) -Expected 'windows-shell'
$env:OS = $oldOS

# Test: compose health parser supports array payloads.
$script:InvokeComposeOriginal = (Get-Command Invoke-Compose).ScriptBlock
function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    return '[{"Health":"healthy","State":"running","Status":"Up 3 seconds (healthy)"}]'
}
Assert-Equal -Name 'Get-ServiceHealthStatus healthy' -Actual (Get-ServiceHealthStatus -Service 'backend-dev') -Expected 'healthy'

# Test: falls back to status text when health is missing.
function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    return '[{"State":"running","Status":"Up 10 seconds (healthy)"}]'
}
Assert-Equal -Name 'Get-ServiceHealthStatus status healthy fallback' -Actual (Get-ServiceHealthStatus -Service 'backend-dev') -Expected 'healthy'



# Regression test: benign stderr from native tools should not fail detection probes.
Assert-True -Name 'Invoke-NativeQuiet tolerates stderr with zero exit' -Condition (Invoke-NativeQuiet -Command 'pwsh' -Args @('-NoProfile','-Command','[Console]::Error.WriteLine("compose provider notice"); exit 0'))

# Regression test: script output strings should stay ASCII-safe for Windows PowerShell encoding defaults.
$devScriptRaw = Get-Content -Path "$PSScriptRoot/dev.ps1" -Raw
$nonAsciiMatches = [regex]::Matches($devScriptRaw, "[^\u0000-\u007F]")
Assert-Equal -Name 'dev.ps1 contains only ASCII chars' -Actual $nonAsciiMatches.Count -Expected 0

# Test: top-level script exports Invoke-Main and can be dot-sourced without running compose.
Assert-True -Name 'Invoke-Main function exists' -Condition ([bool](Get-Command Invoke-Main -ErrorAction SilentlyContinue))

Set-Item -Path function:Invoke-Compose -Value $script:InvokeComposeOriginal

if ($failures.Count -gt 0) {
    Write-Host "`nFAILED TESTS:"
    $failures | ForEach-Object { Write-Host " - $_" }
    exit 1
}

Write-Host "All dev.ps1 compatibility tests passed."
