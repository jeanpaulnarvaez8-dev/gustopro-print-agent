# ============================================================
# GustoPro QR IP Logger — Installer Windows
# Esegui in PowerShell come Administrator:
#   irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/install-qr-logger.ps1 | iex
# ============================================================
#requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$InstallDir   = "C:\GustoPro\qr-logger"
$RepoBase     = "https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main"
$NodeUrl      = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
$NssmUrl      = "https://nssm.cc/release/nssm-2.24.zip"
$ServiceName  = "GustoProQrLogger"

Write-Host "==> GustoPro QR IP Logger — Installer" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Node.js (riusa quello del print agent se gia' installato) ─
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "==> Installo Node.js 20.x..." -ForegroundColor Yellow
  $msi = "$env:TEMP\node-installer.msi"
  Invoke-WebRequest $NodeUrl -OutFile $msi -UseBasicParsing
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path','User')
  Remove-Item $msi -Force
}
Write-Host "Node version: $(node -v)" -ForegroundColor Green

# ── Step 2: NSSM (riusa se gia' presente) ─────────────────────
$nssm = "C:\GustoPro\nssm\nssm.exe"
if (-not (Test-Path $nssm)) {
  Write-Host "==> Installo NSSM..." -ForegroundColor Yellow
  $zip = "$env:TEMP\nssm.zip"
  Invoke-WebRequest $NssmUrl -OutFile $zip -UseBasicParsing
  Expand-Archive $zip -DestinationPath "$env:TEMP\nssm-x" -Force
  New-Item -ItemType Directory -Force -Path "C:\GustoPro\nssm" | Out-Null
  Copy-Item "$env:TEMP\nssm-x\nssm-2.24\win64\nssm.exe" $nssm -Force
  Remove-Item $zip -Force
  Remove-Item "$env:TEMP\nssm-x" -Recurse -Force
}

# ── Step 3: Cartella + qr-logger.js ──────────────────────────
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "==> Scarico qr-logger.js..." -ForegroundColor Yellow
Invoke-WebRequest "$RepoBase/qr-logger.js" -OutFile "$InstallDir\qr-logger.js" -UseBasicParsing

# ── Step 4: Token amministratore (genera o riusa) ────────────
$envFile = "$InstallDir\.env.local"
if (-not (Test-Path $envFile)) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $adminKey = -join ($bytes | ForEach-Object { '{0:x2}' -f $_ })
  "QR_LOGGER_ADMIN_KEY=$adminKey" | Out-File -Encoding ascii $envFile
  Write-Host "==> Generato token admin nuovo." -ForegroundColor Green
} else {
  $adminKey = (Get-Content $envFile | Where-Object { $_ -match '^QR_LOGGER_ADMIN_KEY=' }) -replace '^QR_LOGGER_ADMIN_KEY=',''
  Write-Host "==> Riuso token admin esistente." -ForegroundColor Green
}

# ── Step 5: Servizio Windows ─────────────────────────────────
$nodePath = (Get-Command node).Source
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "==> Servizio esistente, lo aggiorno..." -ForegroundColor Yellow
  & $nssm stop    $ServiceName confirm | Out-Null
  & $nssm remove  $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "==> Installo servizio Windows..." -ForegroundColor Yellow
& $nssm install $ServiceName $nodePath "$InstallDir\qr-logger.js"
& $nssm set $ServiceName AppDirectory $InstallDir
& $nssm set $ServiceName AppStdout    "$InstallDir\qr-logger.log"
& $nssm set $ServiceName AppStderr    "$InstallDir\qr-logger.err.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 5242880   # 5 MB
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName DisplayName "GustoPro QR IP Logger"
& $nssm set $ServiceName Description "Logger IP scansioni QR tavoli (sicurezza/antifrode locale)"
& $nssm set $ServiceName AppEnvironmentExtra `
  "QR_LOGGER_PORT=3000" `
  "QR_LOGGER_ADMIN_KEY=$adminKey" `
  "TENANT_SLUG=riva-beach" `
  "QR_RETENTION_DAYS=90"

Start-Service $ServiceName
Start-Sleep -Seconds 2

# ── Step 6: Firewall — apri 3000 in LAN ─────────────────────
$ruleName = "GustoPro QR Logger (3000)"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  Write-Host "==> Apro porta 3000 nel firewall (solo LAN)..." -ForegroundColor Yellow
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort 3000 `
    -Protocol TCP -Action Allow -Profile Private | Out-Null
}

# ── Step 7: Trova IP LAN del PC ──────────────────────────────
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
          Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -eq 'Dhcp' } |
          Select-Object -First 1).IPAddress
if (-not $lanIp) {
  $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
            Select-Object -First 1).IPAddress
}

# ── Riepilogo ────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  INSTALLAZIONE COMPLETATA" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Servizio: $ServiceName  [$(Get-Service $ServiceName | Select-Object -ExpandProperty Status)]"
Write-Host "Cartella: $InstallDir"
Write-Host "Log:      $InstallDir\qr-logger.log"
Write-Host ""
Write-Host "IP LAN del PC:     $lanIp" -ForegroundColor Cyan
Write-Host "QR tavolo N punta: http://$lanIp`:3000/t/N" -ForegroundColor Cyan
Write-Host ""
Write-Host "Dashboard locale (solo da questo PC o LAN):"
Write-Host "  http://$lanIp`:3000/admin?key=$adminKey" -ForegroundColor Yellow
Write-Host ""
Write-Host "Token admin (salvato in $envFile):"
Write-Host "  $adminKey" -ForegroundColor Magenta
Write-Host ""
Write-Host "Test rapido:"
Write-Host "  curl http://localhost:3000/health"
Write-Host ""
