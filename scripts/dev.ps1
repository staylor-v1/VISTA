# VISTA development environment launcher (PowerShell 5.1+ and PowerShell 7+)
#
# Architecture:
# 1) Environment sensing (desktop app + runtime CLI + compose mode)
# 2) Container orchestration (up/down/restart/logs/etc.)
# 3) Verification (health + inter-service + host connectivity)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# =========================
# Configurable settings
# =========================
$ComposeFile = if ($env:COMPOSE_FILE) { $env:COMPOSE_FILE } else { "docker-compose.dev.yml" }
$LogDirRel = if ($env:LOG_DIR_REL) { $env:LOG_DIR_REL } else { "logs" }
$HealthPollSeconds = if ($env:HEALTH_POLL_SECONDS) { [int]$env:HEALTH_POLL_SECONDS } else { 3 }

$PostgresHealthTimeout = if ($env:POSTGRES_HEALTH_TIMEOUT) { [int]$env:POSTGRES_HEALTH_TIMEOUT } else { 180 }
$MinioHealthTimeout = if ($env:MINIO_HEALTH_TIMEOUT) { [int]$env:MINIO_HEALTH_TIMEOUT } else { 180 }
$BackendHealthTimeout = if ($env:BACKEND_HEALTH_TIMEOUT) { [int]$env:BACKEND_HEALTH_TIMEOUT } else { 300 }
$FrontendHealthTimeout = if ($env:FRONTEND_HEALTH_TIMEOUT) { [int]$env:FRONTEND_HEALTH_TIMEOUT } else { 240 }

$HostFrontendUrl = if ($env:HOST_FRONTEND_URL) { $env:HOST_FRONTEND_URL } else { "http://localhost:3000" }
$HostBackendHealthUrl = if ($env:HOST_BACKEND_HEALTH_URL) { $env:HOST_BACKEND_HEALTH_URL } else { "http://localhost:8000/api/health" }
$HostMinioLiveUrl = if ($env:HOST_MINIO_LIVE_URL) { $env:HOST_MINIO_LIVE_URL } else { "http://localhost:9000/minio/health/live" }

$ScriptDir = $PSScriptRoot
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$LogDir = Join-Path $ProjectRoot $LogDirRel
$PidFile = Join-Path $LogDir ".log_pids"
Set-Location $ProjectRoot

$RuntimeCmd = $null
$ComposeCmd = $null

function Test-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-ProcessRunning {
    param([Parameter(Mandatory = $true)][string]$Pattern)
    try {
        return [bool](Get-Process | Where-Object { $_.ProcessName -match $Pattern })
    } catch {
        return $false
    }
}

function Detect-WindowsDesktopEngine {
    if (Test-ProcessRunning -Pattern "Docker Desktop") { return "docker-desktop" }
    if (Test-ProcessRunning -Pattern "Podman Desktop") { return "podman-desktop" }
    return "none"
}

function Test-CommandWorks {
    param([Parameter(Mandatory = $true)][string]$Command, [string[]]$Args)
    if (-not (Test-Command $Command)) { return $false }
    & $Command @Args *> $null
    return ($LASTEXITCODE -eq 0)
}

function Sense-ContainerEngine {
    $dockerOk = Test-CommandWorks -Command "docker" -Args @("info")
    $podmanOk = Test-CommandWorks -Command "podman" -Args @("info")

    if ($podmanOk) { $script:RuntimeCmd = "podman"; return }
    if ($dockerOk) { $script:RuntimeCmd = "docker"; return }
    throw "Neither podman nor docker CLI is installed and reachable."
}

function Sense-ComposeCommand {
    if (Test-CommandWorks -Command $RuntimeCmd -Args @("compose", "version")) {
        $script:ComposeCmd = @($RuntimeCmd, "compose")
        return
    }

    $legacy = @("$RuntimeCmd-compose", "docker-compose", "podman-compose")
    foreach ($cmd in $legacy) {
        if (Test-CommandWorks -Command $cmd -Args @("version")) {
            $script:ComposeCmd = @($cmd)
            return
        }
    }

    throw "No working compose implementation detected."
}

function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    if ($ComposeCmd.Count -eq 1) {
        & $ComposeCmd[0] -f $ComposeFile @Args
    } else {
        & $ComposeCmd[0] $ComposeCmd[1] -f $ComposeFile @Args
    }
}

function Print-EnvironmentSummary {
    $desktop = "n/a"
    if ($PSVersionTable.PSVersion.Major -ge 5 -and $env:OS -eq "Windows_NT") {
        $desktop = Detect-WindowsDesktopEngine
    }

    Write-Host "Environment detection:"
    Write-Host "  Runtime CLI:           $RuntimeCmd"
    Write-Host "  Compose command:       $($ComposeCmd -join ' ')"
    Write-Host "  Compose file:          $ComposeFile"
    Write-Host "  Windows desktop app:   $desktop"
}

function Wait-ForServiceHealthy {
    param([string]$Service, [int]$TimeoutSeconds = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Invoke-Compose ps --format json $Service | python -c "import json,sys; data=json.load(sys.stdin); print((data[0].get('Health') if data else 'unknown'))" 2>$null
        if ($health -eq "healthy") { Write-Host "✓ $Service healthy"; return }
        if ($health -eq "unhealthy") {
            Invoke-Compose logs --tail=50 $Service
            throw "Service '$Service' became unhealthy."
        }
        Start-Sleep -Seconds $HealthPollSeconds
    }
    Invoke-Compose ps $Service
    Invoke-Compose logs --tail=50 $Service
    throw "Timed out waiting for '$Service' to become healthy."
}

function Invoke-ConnectivityChecks {
    Write-Host "Running cross-service connectivity checks..."
    Invoke-Compose exec -T backend-dev bash -c @"
set -e
cd /app/backend
python - <<'PY'
import asyncio
import asyncpg
import urllib.request

async def verify_postgres():
    conn = await asyncpg.connect('postgresql://postgres:postgres@postgres:5432/postgres')
    try:
        value = await conn.fetchval('SELECT 1')
        assert value == 1
        print('✓ backend-dev -> postgres connectivity OK (SELECT 1)')
    finally:
        await conn.close()

asyncio.run(verify_postgres())
urllib.request.urlopen('http://minio:9000/minio/health/live', timeout=5).read()
print('✓ backend-dev -> minio connectivity OK (/minio/health/live)')
PY
"@
    Invoke-Compose exec -T frontend-dev sh -c "wget -qO- http://backend-dev:8000/api/health >/dev/null && echo '✓ frontend-dev -> backend-dev connectivity OK (/api/health)'"

    Invoke-WebRequest -Uri $HostBackendHealthUrl -UseBasicParsing | Out-Null
    Write-Host "✓ host -> backend-dev connectivity OK ($HostBackendHealthUrl)"
    Invoke-WebRequest -Uri $HostMinioLiveUrl -UseBasicParsing | Out-Null
    Write-Host "✓ host -> minio connectivity OK ($HostMinioLiveUrl)"
    Invoke-WebRequest -Uri $HostFrontendUrl -UseBasicParsing | Out-Null
    Write-Host "✓ host -> frontend-dev connectivity OK ($HostFrontendUrl)"
}

function Start-LogCollector {
    param([string]$Service, [string]$OutputFile)
    $errorFile = "$OutputFile.err"
    $args = if ($ComposeCmd.Count -eq 1) {
        @("-f", $ComposeFile, "logs", "-f", "--no-color", $Service)
    } else {
        @("compose", "-f", $ComposeFile, "logs", "-f", "--no-color", $Service)
    }
    $proc = Start-Process -FilePath $ComposeCmd[0] -ArgumentList $args -RedirectStandardOutput $OutputFile -RedirectStandardError $errorFile -PassThru
    return $proc.Id
}

function Start-LogCollectors {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $pids = @()
    $pids += Start-LogCollector -Service "postgres" -OutputFile (Join-Path $LogDir "postgres.log")
    $pids += Start-LogCollector -Service "minio" -OutputFile (Join-Path $LogDir "minio.log")
    $pids += Start-LogCollector -Service "backend-dev" -OutputFile (Join-Path $LogDir "backend-dev.log")
    $pids += Start-LogCollector -Service "frontend-dev" -OutputFile (Join-Path $LogDir "frontend-dev.log")
    $pids | Set-Content -Path $PidFile
}

function Stop-LogCollectors {
    if (Test-Path $PidFile) {
        Get-Content $PidFile | ForEach-Object {
            if ($_ -match '^\d+$') { Stop-Process -Id ([int]$_) -ErrorAction SilentlyContinue }
        }
        Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
    }
}

Sense-ContainerEngine
Sense-ComposeCommand

$Command = if ($args.Count -ge 1) { $args[0].ToLowerInvariant() } else { "up" }
$Arg2 = if ($args.Count -ge 2) { $args[1] } else { "" }

switch ($Command) {
    "up" {
        Print-EnvironmentSummary
        Invoke-Compose up -d
        Wait-ForServiceHealthy postgres $PostgresHealthTimeout
        Wait-ForServiceHealthy minio $MinioHealthTimeout
        Wait-ForServiceHealthy backend-dev $BackendHealthTimeout
        Wait-ForServiceHealthy frontend-dev $FrontendHealthTimeout
        Invoke-ConnectivityChecks
        Start-LogCollectors
    }
    "verify" {
        Print-EnvironmentSummary
        Wait-ForServiceHealthy postgres 120
        Wait-ForServiceHealthy minio 120
        Wait-ForServiceHealthy backend-dev 180
        Wait-ForServiceHealthy frontend-dev 120
        Invoke-ConnectivityChecks
    }
    "down" { Stop-LogCollectors; Invoke-Compose down }
    "restart" { if ($Arg2) { Invoke-Compose restart $Arg2 } else { Invoke-Compose restart } }
    "logs" { if ($Arg2) { Invoke-Compose logs -f $Arg2 } else { Invoke-Compose logs -f } }
    "test" { Invoke-Compose exec backend-dev bash -c "cd /app/backend && pytest tests/"; Invoke-Compose exec frontend-dev npm test -- --watchAll=false }
    "shell" { if ($Arg2) { Invoke-Compose exec $Arg2 bash } else { Invoke-Compose exec backend-dev bash } }
    "migrate" { Invoke-Compose exec backend-dev bash -c "cd /app/backend && alembic upgrade head" }
    "build" { if ($Arg2) { Invoke-Compose build $Arg2 } else { Invoke-Compose build } }
    "ps" { Invoke-Compose ps }
    default { throw "Usage: ./scripts/dev.ps1 {up|down|restart|logs|test|shell|migrate|build|ps|verify}" }
}
