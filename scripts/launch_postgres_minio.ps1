# Launch postgres + minio with robust runtime/compose detection and health checks.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

function Test-Command { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Test-CommandWorks {
    param([string]$Command, [string[]]$Args)
    if (-not (Test-Command $Command)) { return $false }
    & $Command @Args *> $null
    return ($LASTEXITCODE -eq 0)
}

$runtime = $null
if (Test-CommandWorks -Command "podman" -Args @("info")) {
    $runtime = "podman"
} elseif (Test-CommandWorks -Command "docker" -Args @("info")) {
    $runtime = "docker"
} else {
    throw "Neither podman nor docker CLI is installed and reachable."
}

$composeCmd = $null
if (Test-CommandWorks -Command $runtime -Args @("compose", "version")) {
    $composeCmd = @($runtime, "compose")
} else {
    foreach ($candidate in @("$runtime-compose", "docker-compose", "podman-compose")) {
        if (Test-CommandWorks -Command $candidate -Args @("version")) {
            $composeCmd = @($candidate)
            break
        }
    }
}

if (-not $composeCmd) {
    throw "No working compose implementation detected."
}

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    if ($composeCmd.Count -eq 1) {
        & $composeCmd[0] -f docker-compose.yml @Args
    } else {
        & $composeCmd[0] $composeCmd[1] -f docker-compose.yml @Args
    }
}

function Wait-ForServiceHealthy {
    param([string]$Service, [int]$TimeoutSeconds = 120)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $status = Invoke-Compose ps --format json $Service | python -c @"
import json, sys
raw = json.load(sys.stdin)
rows = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
row = rows[0] if rows else {}
health = str(row.get('Health') or '').strip().lower()
state = str(row.get('State') or '').strip().lower()
status = str(row.get('Status') or '').strip().lower()
if health:
    print(health)
elif 'healthy' in status or '(healthy)' in status:
    print('healthy')
elif 'unhealthy' in status or '(unhealthy)' in status:
    print('unhealthy')
elif state:
    print(state)
else:
    print('unknown')
"@ 2>$null

        if ($status -eq "healthy") {
            Write-Host "$Service is healthy." -ForegroundColor Green
            return
        }
        if ($status -eq "unhealthy") {
            Invoke-Compose logs --tail=50 $Service
            throw "Service '$Service' became unhealthy."
        }
        Start-Sleep -Seconds 2
    }

    Invoke-Compose ps $Service
    Invoke-Compose logs --tail=50 $Service
    throw "Timed out waiting for '$Service' to become healthy."
}

Write-Host "Using runtime: $runtime" -ForegroundColor Cyan
Write-Host "Using compose: $($composeCmd -join ' ')" -ForegroundColor Cyan
Invoke-Compose up -d postgres minio
Wait-ForServiceHealthy postgres 180
Wait-ForServiceHealthy minio 180
Write-Host "Postgres and MinIO are up and healthy." -ForegroundColor Green
