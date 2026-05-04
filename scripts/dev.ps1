# Development environment launcher for VISTA (PowerShell)
# Usage: ./scripts/dev.ps1 [up|down|restart|logs|test|shell|migrate|build|ps] [service]

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ComposeFile = "docker-compose.dev.yml"
$ScriptDir = $PSScriptRoot
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$LogDir = Join-Path $ProjectRoot "logs"
$PidFile = Join-Path $LogDir ".log_pids"

Set-Location $ProjectRoot

$Command = if ($args.Count -ge 1 -and $args[0]) { $args[0].ToLowerInvariant() } else { "up" }
$Arg2 = if ($args.Count -ge 2) { $args[1] } else { "" }

function Wait-ForServiceHealthy {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [int]$TimeoutSeconds = 180
    )

    Write-Host "Waiting for '$Service' health status to be 'healthy' (timeout: ${TimeoutSeconds}s)..."
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = docker compose -f $ComposeFile ps --format json $Service | python -c "import json,sys; data=json.load(sys.stdin); print((data[0].get('Health') if data else 'unknown'))" 2>$null
        if ($health -eq "healthy") {
            Write-Host "  ✓ $Service is healthy."
            return
        }
        if ($health -eq "unhealthy") {
            Write-Host "  ✗ $Service is unhealthy. Recent logs:"
            docker compose -f $ComposeFile logs --tail=50 $Service
            throw "Service '$Service' became unhealthy."
        }
        Start-Sleep -Seconds 3
    }

    docker compose -f $ComposeFile ps $Service
    docker compose -f $ComposeFile logs --tail=50 $Service
    throw "Timed out waiting for '$Service' to become healthy."
}

function Invoke-ConnectivityChecks {
    Write-Host ""
    Write-Host "Running cross-service connectivity checks..."
    docker compose -f $ComposeFile exec -T backend-dev bash -c @"
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
    docker compose -f $ComposeFile exec -T frontend-dev sh -c "wget -qO- http://backend-dev:8000/api/health >/dev/null && echo '✓ frontend-dev -> backend-dev connectivity OK (/api/health)'"
}

function Start-LogCollector {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][string]$OutputFile
    )

    $dockerCmdArgs = @("compose", "-f", $ComposeFile, "logs", "-f", "--no-color", $Service)
    $errorFile = "$OutputFile.err"
    $startProcessArgs = @{
        FilePath = "docker"
        ArgumentList = $dockerCmdArgs
        RedirectStandardOutput = $OutputFile
        RedirectStandardError = $errorFile
        PassThru = $true
    }

    # -WindowStyle is only available in Windows PowerShell editions.
    if ($IsWindows) {
        $startProcessArgs["WindowStyle"] = "Hidden"
    }

    $proc = Start-Process @startProcessArgs
    return $proc.Id
}

switch ($Command) {
    "up" {
        Write-Host "Starting VISTA development environment..."
        docker compose -f $ComposeFile up -d
        Wait-ForServiceHealthy -Service "postgres" -TimeoutSeconds 180
        Wait-ForServiceHealthy -Service "minio" -TimeoutSeconds 180
        Wait-ForServiceHealthy -Service "backend-dev" -TimeoutSeconds 300
        Wait-ForServiceHealthy -Service "frontend-dev" -TimeoutSeconds 240
        Invoke-ConnectivityChecks

        # Create logs directory
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

        # Start log collection in background
        Write-Host "Starting log collection..."
        $pids = @()
        $pids += Start-LogCollector -Service "postgres" -OutputFile (Join-Path $LogDir "postgres.log")
        $pids += Start-LogCollector -Service "minio" -OutputFile (Join-Path $LogDir "minio.log")
        $pids += Start-LogCollector -Service "backend-dev" -OutputFile (Join-Path $LogDir "backend-dev.log")
        $pids += Start-LogCollector -Service "frontend-dev" -OutputFile (Join-Path $LogDir "frontend-dev.log")
        $pids | Set-Content -Path $PidFile

        Write-Host ""
        Write-Host "Development environment started."
        Write-Host ""
        Write-Host "Access points:"
        Write-Host "  Frontend:      http://localhost:3000"
        Write-Host "  Backend API:   http://localhost:8000"
        Write-Host "  API Docs:      http://localhost:8000/docs"
        Write-Host "  MinIO Console: http://localhost:9001"
        Write-Host "  pgAdmin:       http://localhost:8080"
        Write-Host ""
        Write-Host "Logs are being written to:"
        Write-Host "  logs/frontend-dev.log"
        Write-Host "  logs/backend-dev.log"
        Write-Host "  logs/postgres.log"
        Write-Host "  logs/minio.log"
        Write-Host ""
        Write-Host "Useful commands:"
        Write-Host "  View logs:     Get-Content logs/frontend-dev.log -Wait"
        Write-Host "  Stop services: ./scripts/dev.ps1 down"
        Write-Host "  Run tests:     ./scripts/test-docker.sh"
        Write-Host "  Verify links:  ./scripts/dev.ps1 verify"
    }

    "verify" {
        Wait-ForServiceHealthy -Service "postgres" -TimeoutSeconds 120
        Wait-ForServiceHealthy -Service "minio" -TimeoutSeconds 120
        Wait-ForServiceHealthy -Service "backend-dev" -TimeoutSeconds 180
        Wait-ForServiceHealthy -Service "frontend-dev" -TimeoutSeconds 120
        Invoke-ConnectivityChecks
        Write-Host "All health and connectivity checks passed."
    }

    "down" {
        Write-Host "Stopping development environment..."

        # Stop log collection processes
        if (Test-Path $PidFile) {
            Write-Host "Stopping log collection..."
            Get-Content $PidFile | ForEach-Object {
                if ($_ -match '^\d+$') {
                    Stop-Process -Id ([int]$_) -ErrorAction SilentlyContinue
                }
            }
            Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
        }

        docker compose -f $ComposeFile down
        Write-Host "Development environment stopped."
    }

    "restart" {
        Write-Host "Restarting development environment..."
        if ($Arg2) {
            docker compose -f $ComposeFile restart $Arg2
        } else {
            docker compose -f $ComposeFile restart
        }
        Write-Host "Development environment restarted."
    }

    "logs" {
        if ($Arg2) {
            docker compose -f $ComposeFile logs -f $Arg2
        } else {
            docker compose -f $ComposeFile logs -f
        }
    }

    "test" {
        # Check if containers are running
        $psOutput = docker compose -f $ComposeFile ps
        if (-not ($psOutput | Select-String -Pattern "Up" -SimpleMatch)) {
            Write-Error "Error: Development containers are not running.`n`nPlease start the development environment first:`n  ./scripts/dev.ps1 up`n`nOr use the standalone test runner:`n  ./scripts/test-docker.sh"
            exit 1
        }

        Write-Host "Running tests in containers..."
        Write-Host ""
        Write-Host "Backend tests:"
        docker compose -f $ComposeFile exec backend-dev bash -c "cd /app/backend && pytest tests/"
        Write-Host ""
        Write-Host "Frontend tests:"
        docker compose -f $ComposeFile exec frontend-dev npm test -- --watchAll=false
    }

    "shell" {
        $service = if ($Arg2) { $Arg2 } else { "backend-dev" }
        Write-Host "Opening shell in $service..."
        docker compose -f $ComposeFile exec $service bash
    }

    "migrate" {
        Write-Host "Running database migrations..."
        docker compose -f $ComposeFile exec backend-dev bash -c "cd /app/backend && alembic upgrade head"
        Write-Host "Migrations completed."
    }

    "build" {
        Write-Host "Building containers..."
        if ($Arg2) {
            docker compose -f $ComposeFile build $Arg2
        } else {
            docker compose -f $ComposeFile build
        }
        Write-Host "Build completed."
    }

    "ps" {
        docker compose -f $ComposeFile ps
    }

    default {
        Write-Host "Usage: ./scripts/dev.ps1 {up|down|restart|logs|test|shell|migrate|build|ps|verify}"
        Write-Host ""
        Write-Host "Commands:"
        Write-Host "  up       - Start all services"
        Write-Host "  down     - Stop all services"
        Write-Host "  restart  - Restart services"
        Write-Host "  logs     - View logs (all or specific service)"
        Write-Host "  test     - Run tests in containers"
        Write-Host "  shell    - Open shell in container (default: backend-dev)"
        Write-Host "  migrate  - Run database migrations"
        Write-Host "  build    - Build or rebuild containers"
        Write-Host "  ps       - Show container status"
        Write-Host "  verify   - Run health and inter-service connectivity checks"
        exit 1
    }
}
