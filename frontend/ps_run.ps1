# Frontend run script for PowerShell
# Starts the React development server with optimizations

param(
    [switch]$Build,
    [switch]$Analyze
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info {
    param([string]$Message)
    Write-Host "[frontend-run] $Message" -ForegroundColor Cyan
}

function Write-Error-Info {
    param([string]$Message)
    Write-Host "[frontend-run] ERROR: $Message" -ForegroundColor Red
}

function Start-Frontend {
    # Check if we're in the frontend directory
    if (-not (Test-Path "package.json")) {
        Write-Error-Info "This script must be run from the frontend directory"
        exit 1
    }
    
    # Check if Node.js and npm are installed
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error-Info "Node.js is not installed. Please run install.sh first."
        exit 1
    }
    
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error-Info "npm is not installed. Please run install.sh first."
        exit 1
    }
    
    # Check if node_modules exists
    if (-not (Test-Path "node_modules")) {
        Write-Error-Info "node_modules not found. Please run install.sh first."
        exit 1
    }
    
    Write-Info "Starting React frontend development server..."
    Write-Info "Server will be available at http://localhost:3000"
    Write-Info "Press Ctrl+C to stop the server"
    
    # Set environment variables for optimized development
    $env:FAST_REFRESH = "true"
    $env:GENERATE_SOURCEMAP = "true"
    $env:SKIP_PREFLIGHT_CHECK = "true"
    
    # Start the development server with optimizations
    # Use cross-env if available, otherwise just run npm start directly
    if (Get-Command cross-env -ErrorAction SilentlyContinue) {
        npx cross-env FAST_REFRESH=true GENERATE_SOURCEMAP=true SKIP_PREFLIGHT_CHECK=true npm start
    } else {
        npm start
    }
}

# Handle different modes
if ($Analyze) {
    Write-Info "Building and analyzing bundle..."
    npm run build
    if ((Get-Command npx -ErrorAction SilentlyContinue) -and (Test-Path "build/static/js")) {
        $jsFiles = Get-ChildItem "build/static/js/*.js" -ErrorAction SilentlyContinue
        if ($jsFiles) {
            npx webpack-bundle-analyzer $jsFiles[0].FullName
        } else {
            Write-Info "No JavaScript files found in build/static/js"
        }
    } else {
        Write-Info "Bundle analyzer not available or build failed"
    }
}
elseif ($Build) {
    Write-Info "Building for production..."
    npm run build
    Write-Info "Production build complete! Files are in the 'build' directory"
}
else {
    Start-Frontend
}
