# Backend run script for PowerShell
# Tries to load the virtual environment (.venv) from current dir or parent dir before proceeding
# Starts PostgreSQL and MinIO containers, then starts the FastAPI backend with uvicorn

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Function to check if a command exists
function Test-Command {
    param($CommandName)
    return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue)
}

# Function to check PostgreSQL
function Test-PostgreSQL {
    param(
        [int]$MaxAttempts = 30,
        [string]$PostgresHost = $(if ($env:POSTGRES_SERVER) { $env:POSTGRES_SERVER } else { "localhost" }),
        [int]$Port = $(if ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { 5433 })
    )
    
    Write-Host "Checking PostgreSQL at ${PostgresHost}:${Port}..." -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $tcpClient = New-Object System.Net.Sockets.TcpClient
            $tcpClient.ConnectAsync($PostgresHost, $Port).Wait(1000) | Out-Null
            if ($tcpClient.Connected) {
                $tcpClient.Close()
                Write-Host "PostgreSQL is ready" -ForegroundColor Green
                return $true
            }
            $tcpClient.Close()
        } catch {
            # Connection failed, continue waiting
        }
        Write-Host "Waiting for PostgreSQL (attempt $attempt/$MaxAttempts)..."
        Start-Sleep -Seconds 1
    }
    Write-Host "ERROR: PostgreSQL not responding after $MaxAttempts attempts" -ForegroundColor Red
    Write-Host "Make sure PostgreSQL is running: podman compose up -d postgres" -ForegroundColor Yellow
    return $false
}

# Function to check MinIO
function Test-MinIO {
    param(
        [int]$MaxAttempts = 30,
        [string]$Endpoint = $(if ($env:S3_ENDPOINT) { $env:S3_ENDPOINT } else { "localhost:9000" }),
        [bool]$UseSsl = ($env:S3_USE_SSL -eq "true")
    )
    
    $protocol = if ($UseSsl) { "https" } else { "http" }
    $url = "${protocol}://${Endpoint}/minio/health/live"
    
    Write-Host "Checking MinIO at ${protocol}://${Endpoint}..." -ForegroundColor Cyan
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                Write-Host "MinIO is ready" -ForegroundColor Green
                return $true
            }
        } catch {
            # Connection failed, continue waiting
        }
        Write-Host "Waiting for MinIO (attempt $attempt/$MaxAttempts)..."
        Start-Sleep -Seconds 1
    }
    Write-Host "ERROR: MinIO not responding after $MaxAttempts attempts" -ForegroundColor Red
    Write-Host "Make sure MinIO is running: podman compose up -d minio" -ForegroundColor Yellow
    return $false
}

# Check for virtual environment in current directory
if (Test-Path ".venv") {
    Write-Host "Found .venv in current directory, activating..." -ForegroundColor Cyan
    & ".\.venv\Scripts\Activate.ps1"
    if (-not (Test-Command uvicorn)) {
        Write-Host "ERROR: uvicorn not found after activating virtual environment. Please run 'uv sync'" -ForegroundColor Red
        exit 1
    }
}
# Check for virtual environment in parent directory
elseif (Test-Path "..\.venv") {
    Write-Host "Found .venv in parent directory, activating..." -ForegroundColor Cyan
    & "..\\.venv\Scripts\Activate.ps1"
    if (-not (Test-Command uvicorn)) {
        Write-Host "ERROR: uvicorn not found after activating virtual environment. Please run 'uv sync'" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "No .venv found in current or parent directory, proceeding without virtual environment" -ForegroundColor Yellow
    if (-not (Test-Command uvicorn)) {
        Write-Host "ERROR: uvicorn not found. Please install dependencies or activate a virtual environment." -ForegroundColor Red
        exit 1
    }
}

Write-Host "Checking container health before starting backend..." -ForegroundColor Cyan

# Load environment variables if .env exists
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*?)\s*$') {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}
elseif (Test-Path "..\.env") {
    Get-Content "..\.env" | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]*?)\s*=\s*(.*?)\s*$') {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

# Run health checks
if (-not (Test-PostgreSQL)) {
    exit 1
}

if (-not (Test-MinIO)) {
    exit 1
}

# Get port from environment or default to 8000
$Port = if ($env:PORT) { $env:PORT } else { "8000" }

Write-Host "All containers are healthy" -ForegroundColor Green
Write-Host "Starting uvicorn main:app --host 0.0.0.0 --port $Port" -ForegroundColor Cyan
uvicorn main:app --host 0.0.0.0 --port $Port
