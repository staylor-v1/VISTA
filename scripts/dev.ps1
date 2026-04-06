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

function Start-LogCollector {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][string]$OutputFile
    )

    $dockerCmdArgs = @("compose", "-f", $ComposeFile, "logs", "-f", "--no-color", $Service)
    $proc = Start-Process -FilePath "docker" -ArgumentList $dockerCmdArgs -RedirectStandardOutput $OutputFile -RedirectStandardError $OutputFile -PassThru -WindowStyle Hidden
    return $proc.Id
}

switch ($Command) {
    "up" {
        Write-Host "Starting VISTA development environment..."
        docker compose -f $ComposeFile up -d

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
        Write-Host "Usage: ./scripts/dev.ps1 {up|down|restart|logs|test|shell|migrate|build|ps}"
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
        exit 1
    }
}
