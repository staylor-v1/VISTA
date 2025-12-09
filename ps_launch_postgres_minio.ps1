# Launch postgres + minio using podman or docker.
# Auto-detects which container runtime is available.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Change to script directory
Set-Location $PSScriptRoot

# Detect container runtime (prefer podman, fallback to docker)
$containerCmd = $null
if (Get-Command podman -ErrorAction SilentlyContinue) {
    $containerCmd = "podman"
    Write-Host "Found podman" -ForegroundColor Green
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $containerCmd = "docker"
    Write-Host "Found docker" -ForegroundColor Green
} else {
    Write-Error "Error: Neither podman nor docker is installed."
    exit 1
}

Write-Host "Using $containerCmd to launch postgres and minio..." -ForegroundColor Cyan

# Launch postgres and minio services
& $containerCmd compose -f docker-compose.yml up -d postgres minio

if ($LASTEXITCODE -eq 0) {
    Write-Host "Successfully launched postgres and minio" -ForegroundColor Green
    Write-Host ""
    Write-Host "To stop and remove containers and volumes (hard reset), run:" -ForegroundColor Yellow
    Write-Host "  $containerCmd compose -f docker-compose.yml down -v" -ForegroundColor Yellow
} else {
    Write-Error "Failed to launch containers"
    exit $LASTEXITCODE
}
