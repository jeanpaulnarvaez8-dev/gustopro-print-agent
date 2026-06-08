# GustoPro Print Agent — UPDATE (no reinstall, solo aggiorna agent.js + riavvia servizio)
#
# Lancio: irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/update.ps1 | iex
#
# Cosa fa (tutto < 10 secondi):
#   1. Stop servizio Windows GustoProPrintAgent
#   2. Scarica agent.js fresh da GitHub
#   3. Verifica che la versione scaricata abbia il fix routing
#   4. Riavvia il servizio
#   5. Mostra log live

$ErrorActionPreference = 'Stop'
$INSTALL_DIR = 'C:\GustoPro\agent'
$SERVICE_NAME = 'GustoProPrintAgent'
$AGENT_URL = 'https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/agent.js'

# Pausa pre-chiusura (cosi' la finestra resta aperta per leggere)
function Stop-WithPause($code) {
    Write-Host ""
    Write-Host "Premi INVIO per chiudere..." -ForegroundColor Cyan
    Read-Host | Out-Null
    exit $code
}

# Admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "ERRORE: PowerShell NON e' Amministratore" -ForegroundColor Red
    Write-Host "Tasto destro su PowerShell -> 'Esegui come amministratore'" -ForegroundColor Yellow
    Stop-WithPause 1
}

# Installazione preesistente?
if (-not (Test-Path "$INSTALL_DIR\agent.js")) {
    Write-Host "ERRORE: agent non installato. Lancia install.ps1 prima." -ForegroundColor Red
    Stop-WithPause 1
}
if (-not (Test-Path "$INSTALL_DIR\nssm.exe")) {
    Write-Host "ERRORE: nssm.exe non trovato. Lancia install.ps1." -ForegroundColor Red
    Stop-WithPause 1
}

$nssm = "$INSTALL_DIR\nssm.exe"

Write-Host "==> Stop servizio $SERVICE_NAME" -ForegroundColor Cyan
& $nssm stop $SERVICE_NAME 2>&1 | Out-Null
$tries = 0
while ($tries -lt 15) {
    $svc = Get-Service -Name $SERVICE_NAME -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -eq 'Stopped') { break }
    Start-Sleep -Seconds 1
    $tries++
}
Write-Host "    Servizio fermato" -ForegroundColor Green

Write-Host "==> Scarico agent.js aggiornato" -ForegroundColor Cyan
$oldSize = (Get-Item "$INSTALL_DIR\agent.js").Length
try {
    # Cache-busting: aggiungi query string univoca cosi' GitHub non serve cache
    $cb = [DateTime]::UtcNow.Ticks
    Invoke-WebRequest -Uri "$AGENT_URL`?cb=$cb" -OutFile "$INSTALL_DIR\agent.js" -UseBasicParsing
} catch {
    Write-Host "ERRORE download: $($_.Exception.Message)" -ForegroundColor Red
    & $nssm start $SERVICE_NAME 2>&1 | Out-Null
    Stop-WithPause 1
}
$newSize = (Get-Item "$INSTALL_DIR\agent.js").Length
Write-Host "    Scaricato: $newSize byte (era $oldSize)" -ForegroundColor Green

# Verifica integrita': il file nuovo DEVE contenere 'sendToCustomPrinter'
$content = Get-Content "$INSTALL_DIR\agent.js" -Raw
if ($content -notmatch 'sendToCustomPrinter') {
    Write-Host ""
    Write-Host "ATTENZIONE: il file scaricato e' la VECCHIA versione!" -ForegroundColor Red
    Write-Host "Probabile cache CDN. Riprova fra 2 minuti." -ForegroundColor Yellow
    & $nssm start $SERVICE_NAME 2>&1 | Out-Null
    Stop-WithPause 1
}
Write-Host "    Versione NUOVA confermata (ha routing BAR)" -ForegroundColor Green

Write-Host "==> Riavvio servizio" -ForegroundColor Cyan
& $nssm start $SERVICE_NAME 2>&1 | Out-Null
Start-Sleep -Seconds 4
$svc = Get-Service -Name $SERVICE_NAME -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "    Servizio RUNNING" -ForegroundColor Green
} else {
    Write-Host "    ATTENZIONE: servizio in stato $($svc.Status)" -ForegroundColor Red
    Write-Host "    Controlla log: $INSTALL_DIR\logs\agent.log" -ForegroundColor Yellow
    Stop-WithPause 1
}

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  AGENT AGGIORNATO E ATTIVO" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Adesso:" -ForegroundColor Cyan
Write-Host "    - Preconto asporto -> .21 BAR" -ForegroundColor Cyan
Write-Host "    - Preconto tavolo  -> .24 SALA (come prima)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Vedi log live:" -ForegroundColor DarkGray
Write-Host "    Get-Content $INSTALL_DIR\logs\agent.log -Wait -Tail 10" -ForegroundColor DarkGray
Write-Host ""

# Mostra subito gli ultimi 5 log per conferma
Write-Host "Ultimi log:" -ForegroundColor Cyan
if (Test-Path "$INSTALL_DIR\logs\agent.log") {
    Get-Content "$INSTALL_DIR\logs\agent.log" -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Stop-WithPause 0
