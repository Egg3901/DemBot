# Restart the DemBot process via PM2 if present

param(
  [string]$AppName = 'dembot'
)

if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  pm2 restart $AppName
} else {
  Write-Host 'PM2 not found. Use /restart slash command or run scripts/boot.ps1.'
}

