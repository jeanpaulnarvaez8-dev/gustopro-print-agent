# GustoPro Print Agent — installer Windows
#
# Esegui in PowerShell come Amministratore:
#
#   $env:PRINT_AGENT_TOKEN = "il_tuo_token"
#   irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/install.ps1 | iex
#
# Cosa fa:
#   1. Verifica Node.js (lo scarica se manca)
#   2. Crea C:\GustoPro\agent\
#   3. Scarica agent.js + package.json dal repo GitHub
#   4. Scarica NSSM (Non-Sucking Service Manager) per il servizio Windows
#   5. Crea il servizio "GustoProPrintAgent" che parte al boot del PC
#   6. Lo avvia
#
# Disinstallazione:
#   irm https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/uninstall.ps1 | iex

$ErrorActionPreference = 'Stop'
$REPO_RAW = 'https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main'
$INSTALL_DIR = 'C:\GustoPro\agent'
$NSSM_URL = 'https://nssm.cc/release/nssm-2.24.zip'
$NODE_LTS = 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'
$SERVICE_NAME = 'GustoProPrintAgent'

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) {
    Write-Host "    OK $msg" -ForegroundColor Green
}
function Write-Warn($msg) {
    Write-Host "    !! $msg" -ForegroundColor Yellow
}

# ── Helper: pausa prima di chiudere (cosi' l'utente legge l'errore) ──
function Stop-WithPause($code) {
    Write-Host ""
    Write-Host "Premi INVIO per chiudere..." -ForegroundColor Cyan
    Read-Host | Out-Null
    exit $code
}

# ── Step 0: amministratore? ──────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "ERRORE: PowerShell NON e' aperto come AMMINISTRATORE" -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Cosa fare:" -ForegroundColor Yellow
    Write-Host "  1. Chiudi questa finestra" -ForegroundColor Yellow
    Write-Host "  2. Premi tasto Windows, scrivi 'powershell'" -ForegroundColor Yellow
    Write-Host "  3. TASTO DESTRO su 'Windows PowerShell'" -ForegroundColor Yellow
    Write-Host "  4. Clicca 'Esegui come amministratore'" -ForegroundColor Yellow
    Write-Host "  5. Riprova il comando" -ForegroundColor Yellow
    Stop-WithPause 1
}

# ── Step 1: PRINT_AGENT_TOKEN obbligatorio ──────────────────────────
if (-not $env:PRINT_AGENT_TOKEN) {
    Write-Host ""
    Write-Host "ERRORE: variabile PRINT_AGENT_TOKEN non impostata." -ForegroundColor Red
    Write-Host ""
    Write-Host 'Prima di lanciare lo script, esegui:' -ForegroundColor Yellow
    Write-Host '  $env:PRINT_AGENT_TOKEN = "il_token_segreto"' -ForegroundColor Yellow
    Write-Host "poi rilancia l'installer." -ForegroundColor Yellow
    Stop-WithPause 1
}
$TOKEN = $env:PRINT_AGENT_TOKEN

Write-Step "Setup GustoPro Print Agent su $env:COMPUTERNAME"

# ── Step 2: Node.js installato? ──────────────────────────────────────
Write-Step "Verifica Node.js"
$nodeOk = $false
try {
    $nodeVer = & node --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVer -match '^v(\d+)') {
        $major = [int]$Matches[1]
        if ($major -ge 18) {
            Write-Ok "Node.js $nodeVer presente"
            $nodeOk = $true
        } else {
            Write-Warn "Node.js $nodeVer troppo vecchio (serve >=18). Reinstallo."
        }
    }
} catch { }

if (-not $nodeOk) {
    Write-Step "Scarico e installo Node.js LTS (~30MB)"
    $msi = "$env:TEMP\node-lts.msi"
    Invoke-WebRequest -Uri $NODE_LTS -OutFile $msi -UseBasicParsing
    Write-Host "    installazione silenziosa MSI..."
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart ADDLOCAL=ALL" -Wait
    Remove-Item $msi -ErrorAction SilentlyContinue
    # Aggiorna PATH della sessione corrente
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $nodeVer = & node --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERRORE: Node.js non installato correttamente. Reboot del PC e riprova." -ForegroundColor Red
        exit 1
    }
    Write-Ok "Node.js $nodeVer installato"
}

# ── Step 3: cartella + scarica agent ────────────────────────────────
Write-Step "Cartella $INSTALL_DIR"
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\logs" | Out-Null
Write-Ok "Cartella pronta"

Write-Step "Scarico agent.js + package.json"
Invoke-WebRequest -Uri "$REPO_RAW/agent.js"     -OutFile "$INSTALL_DIR\agent.js"     -UseBasicParsing
Invoke-WebRequest -Uri "$REPO_RAW/package.json" -OutFile "$INSTALL_DIR\package.json" -UseBasicParsing
Write-Ok "agent.js scaricato"

# ── Step 4: NSSM ─────────────────────────────────────────────────────
Write-Step "NSSM (gestore servizio Windows)"
$nssmExe = "$INSTALL_DIR\nssm.exe"
if (-not (Test-Path $nssmExe)) {
    $zip = "$env:TEMP\nssm.zip"
    $extract = "$env:TEMP\nssm-extract"
    Invoke-WebRequest -Uri $NSSM_URL -OutFile $zip -UseBasicParsing
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    # NSSM zip contiene win32/ e win64/. Usiamo win64.
    Copy-Item -Path "$extract\nssm-2.24\win64\nssm.exe" -Destination $nssmExe -Force
    Remove-Item -Recurse -Force $extract
    Remove-Item $zip -ErrorAction SilentlyContinue
    Write-Ok "NSSM scaricato"
} else {
    Write-Ok "NSSM gia' presente"
}

# ── Step 5: stop + rimuovi servizio precedente ───────────────────────
Write-Step "Rimuovo eventuale servizio precedente"
$svc = Get-Service -Name $SERVICE_NAME -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        & $nssmExe stop $SERVICE_NAME 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }
    & $nssmExe remove $SERVICE_NAME confirm | Out-Null
    Write-Ok "Servizio precedente rimosso"
} else {
    Write-Ok "Nessun servizio precedente"
}

# ── Step 6: trova node.exe full path ─────────────────────────────────
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
Write-Step "node.exe: $nodeExe"

# ── Step 7: crea servizio + env vars ─────────────────────────────────
Write-Step "Creo servizio $SERVICE_NAME"
& $nssmExe install $SERVICE_NAME $nodeExe "$INSTALL_DIR\agent.js" | Out-Null
& $nssmExe set $SERVICE_NAME AppDirectory $INSTALL_DIR | Out-Null
& $nssmExe set $SERVICE_NAME DisplayName "GustoPro Print Agent" | Out-Null
& $nssmExe set $SERVICE_NAME Description "Bridge tra backend GustoPro e stampanti LAN (bar, cucina, preconto)" | Out-Null
& $nssmExe set $SERVICE_NAME Start SERVICE_AUTO_START | Out-Null
& $nssmExe set $SERVICE_NAME AppStdout "$INSTALL_DIR\logs\agent.log" | Out-Null
& $nssmExe set $SERVICE_NAME AppStderr "$INSTALL_DIR\logs\agent.log" | Out-Null
& $nssmExe set $SERVICE_NAME AppRotateFiles 1 | Out-Null
& $nssmExe set $SERVICE_NAME AppRotateOnline 1 | Out-Null
& $nssmExe set $SERVICE_NAME AppRotateBytes 10485760 | Out-Null
# Restart automatico su crash con backoff
& $nssmExe set $SERVICE_NAME AppExit Default Restart | Out-Null
& $nssmExe set $SERVICE_NAME AppRestartDelay 3000 | Out-Null
# Variabili d'ambiente per l'agent
$envVars = @(
    "CLOUD_BASE=https://gestione.gustopro.it/api",
    "TENANT_SLUG=riva-beach",
    "PRINT_AGENT_TOKEN=$TOKEN",
    "POLL_SECONDS=2",
    "PRINTER_IP=192.168.1.24",
    "PRINTER_PORT=9100",
    "KITCHEN_PRINTER_IP=192.168.1.23",
    "KITCHEN_PRINTER_PORT=9100",
    "BAR_PRINTER_IP=192.168.1.21",
    "BAR_PRINTER_PORT=9100",
    "LISTEN_PORT=9110",
    "BIND=127.0.0.1",
    "ALLOW_ORIGIN=https://gestione.gustopro.it"
)
& $nssmExe set $SERVICE_NAME AppEnvironmentExtra ($envVars -join "`0") | Out-Null
Write-Ok "Servizio creato"

# ── Step 8: avvia ────────────────────────────────────────────────────
Write-Step "Avvio servizio"
& $nssmExe start $SERVICE_NAME | Out-Null
Start-Sleep -Seconds 3
$svc = Get-Service -Name $SERVICE_NAME -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Ok "Servizio AVVIATO ($($svc.Status))"
} else {
    Write-Warn "Servizio in stato: $($svc.Status). Controlla i log: $INSTALL_DIR\logs\agent.log"
}

# ── Step 9: firewall per IP loopback 9110 (opzionale, locale only) ──
Write-Step "Configuro regole firewall in uscita"
$rules = @(
    @{ Name = 'GustoPro Agent → Stampante Preconto (.24)'; RemotePort = 9100; RemoteAddress = '192.168.1.24' },
    @{ Name = 'GustoPro Agent → Stampante Cucina (.23)';   RemotePort = 9100; RemoteAddress = '192.168.1.23' },
    @{ Name = 'GustoPro Agent → Stampante Bar (.21)';      RemotePort = 9100; RemoteAddress = '192.168.1.21' }
)
foreach ($r in $rules) {
    if (-not (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)) {
        try {
            New-NetFirewallRule `
                -DisplayName $r.Name `
                -Direction Outbound -Action Allow `
                -Protocol TCP -RemotePort $r.RemotePort `
                -RemoteAddress $r.RemoteAddress `
                -Profile Any | Out-Null
        } catch {
            Write-Warn "Non sono riuscito a creare la regola firewall ($($r.Name)). Probabilmente i blocchi outbound sono gia' disattivati — OK."
        }
    }
}
Write-Ok "Firewall configurato"

# ── Riepilogo finale ─────────────────────────────────────────────────
Write-Host ""
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  GustoPro Print Agent INSTALLATO E ATTIVO" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Servizio Windows:  $SERVICE_NAME"
Write-Host "  Cartella:          $INSTALL_DIR"
Write-Host "  Log file:          $INSTALL_DIR\logs\agent.log"
Write-Host ""
Write-Host "  Comandi utili:"
Write-Host "    Get-Service $SERVICE_NAME"
Write-Host "    Restart-Service $SERVICE_NAME"
Write-Host "    Get-Content $INSTALL_DIR\logs\agent.log -Wait -Tail 20"
Write-Host ""
Write-Host "Il servizio parte automaticamente ad ogni boot del PC."
Write-Host "Puoi spegnere il Mac quando vuoi — le stampe ora vengono da qui."
Write-Host ""
