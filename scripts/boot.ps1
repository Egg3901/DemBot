# Boot script for DemBot (Windows PowerShell)
# - Pull latest from git
# - Install deps (npm ci)
# - Start via PM2 if available; otherwise start Node detached

param(
  [string]$AppName = 'dembot'
)

$ErrorActionPreference = 'Continue'

function Write-Stamp($msg) {
  $ts = (Get-Date).ToString('u')
  Write-Host "[$ts] $msg"
}

try {
  $repo = Split-Path -Parent $PSScriptRoot
  Set-Location $repo
  Write-Stamp "Repo: $repo"

  # Ensure git present
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Stamp 'git not found on PATH; skipping pull.'
  } else {
    try {
      $branch = (git rev-parse --abbrev-ref HEAD).Trim()
      Write-Stamp "Current branch: $branch"
      git fetch --all --prune
      git pull --ff-only
      Write-Stamp 'Git updated.'
    } catch { Write-Stamp "Git update failed: $($_.Exception.Message)" }
  }

  # Install production deps
  if (Test-Path package-lock.json) {
    Write-Stamp 'Installing deps via npm ci --omit=dev...'
    npm ci --omit=dev
  } else {
    Write-Stamp 'Installing deps via npm install --omit=dev...'
    npm install --omit=dev
  }

  # Start with PM2 if available
  if (Get-Command pm2 -ErrorAction SilentlyContinue) {
    Write-Stamp 'Starting via PM2...'
    pm2 start index.js --name $AppName --update-env | Out-Null
    pm2 save | Out-Null
  } else {
    Write-Stamp 'PM2 not found; starting node detached.'
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if ($null -eq $node) { Write-Stamp 'node not found on PATH.'; exit 1 }
    Start-Process -FilePath node -ArgumentList 'index.js' -WorkingDirectory $repo -WindowStyle Hidden
  }

  Write-Stamp 'Boot script completed.'
} catch {
  Write-Stamp "Boot failed: $($_.Exception.Message)"
  exit 1
}

