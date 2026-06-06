# GustoPro Print Agent — disinstaller
#
# Rimuove il servizio Windows + la cartella installazione.
# Esegui in PowerShell come Amministratore.

$ErrorActionPreference = 'Stop'
$INSTALL_DIR = 'C:\GustoPro\agent'
$SERVICE_NAME = 'GustoProPrintAgent'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Eseguire come Amministratore" -ForegroundColor Red
    exit 1
}

Write-Host "Stop servizio..."
$nssmExe = "$INSTALL_DIR\nssm.exe"
if (Test-Path $nssmExe) {
    & $nssmExe stop $SERVICE_NAME 2>$null | Out-Null
    Start-Sleep 2
    & $nssmExe remove $SERVICE_NAME confirm 2>$null | Out-Null
    Write-Host "Servizio rimosso." -ForegroundColor Green
}

Write-Host "Rimuovo cartella $INSTALL_DIR..."
if (Test-Path $INSTALL_DIR) {
    Remove-Item -Recurse -Force $INSTALL_DIR
    Write-Host "Cartella rimossa." -ForegroundColor Green
}

Write-Host ""
Write-Host "Disinstallazione completa." -ForegroundColor Green
