#!/bin/bash
# ============================================================
# GustoPro QR Logger — Installer backup Mac (one-time setup)
# ------------------------------------------------------------
# Crea ~/.gustopro-qr-backup.env + launchd plist che esegue
# mac-backup.sh ogni 30 minuti.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main/setup-mac-backup.sh | bash
# oppure scaricato e lanciato:
#   bash setup-mac-backup.sh
# ============================================================
set -euo pipefail

REPO_BASE="https://raw.githubusercontent.com/jeanpaulnarvaez8-dev/gustopro-print-agent/main"
INSTALL_DIR="$HOME/Library/Application Support/GustoProQrBackup"
PLIST="$HOME/Library/LaunchAgents/it.gustopro.qr-backup.plist"
CONFIG="$HOME/.gustopro-qr-backup.env"
BACKUP_DIR="$HOME/RivaBeach-QR-Backup"

echo "==> GustoPro QR Backup — Setup Mac"
echo ""

# ── Step 1: chiedi IP + token al user ─────────────────────────
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  source "$CONFIG"
  echo "Trovata config esistente:"
  echo "  PC_IP=$PC_IP"
  echo "  PORT=${PORT:-3000}"
  echo ""
  read -p "Vuoi sovrascriverla? [s/N] " ow
  if [[ ! "$ow" =~ ^[sS]$ ]]; then
    echo "Mantengo config esistente."
    SKIP_PROMPT=1
  fi
fi

if [ "${SKIP_PROMPT:-0}" != "1" ]; then
  echo "Inserisci i dati che l'installer Windows ti ha mostrato alla fine:"
  echo ""
  read -p "  IP del PC Windows del Riva (es. 192.168.1.50): " PC_IP
  read -p "  Porta [3000]: " PORT
  PORT=${PORT:-3000}
  read -p "  Token admin (lungo, esadecimale): " ADMIN_KEY
  echo ""

  cat > "$CONFIG" <<EOF
# GustoPro QR Logger — backup config per Mac di JP
# Auto-generato $(date '+%Y-%m-%d %H:%M:%S')
PC_IP="$PC_IP"
PORT="$PORT"
ADMIN_KEY="$ADMIN_KEY"
EOF
  chmod 600 "$CONFIG"
  echo "✓ Config salvata in $CONFIG (permessi 600)"
fi

# ── Step 2: scarica mac-backup.sh ─────────────────────────────
mkdir -p "$INSTALL_DIR"
mkdir -p "$BACKUP_DIR"

echo "==> Scarico mac-backup.sh..."
curl -fsSL "$REPO_BASE/mac-backup.sh" -o "$INSTALL_DIR/mac-backup.sh"
chmod +x "$INSTALL_DIR/mac-backup.sh"

# ── Step 3: test rapido prima di installare il launchd ───────
echo ""
echo "==> Test connessione al PC Windows..."
# shellcheck disable=SC1090
source "$CONFIG"
PORT="${PORT:-3000}"
if curl -fsS --max-time 8 "http://${PC_IP}:${PORT}/health" >/dev/null 2>&1; then
  echo "✓ PC raggiungibile."
else
  echo "⚠ Il PC ${PC_IP}:${PORT} non risponde adesso."
  echo "  (Non e' un problema: il backup riprovera' ogni 30 min."
  echo "   Verifica che sei in LAN col Riva, e il servizio Windows e' attivo.)"
fi

# ── Step 4: crea launchd plist ───────────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>it.gustopro.qr-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/mac-backup.sh</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$BACKUP_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$BACKUP_DIR/launchd.err.log</string>
</dict>
</plist>
EOF

# ── Step 5: (re)load launchd ─────────────────────────────────
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "============================================================"
echo "  ✅ BACKUP MAC ATTIVATO"
echo "============================================================"
echo ""
echo "Cartella backup:  $BACKUP_DIR"
echo "  └─ scans-YYYY-MM-DD.jsonl  (un file per giorno)"
echo "  └─ backup.log              (log esiti)"
echo ""
echo "Frequenza:        ogni 30 minuti (anche dopo reboot)"
echo "Avvio:            automatico al login del Mac"
echo ""
echo "Test manuale:"
echo "  bash \"$INSTALL_DIR/mac-backup.sh\""
echo "  cat \"$BACKUP_DIR/backup.log\""
echo ""
echo "Per disinstallare:"
echo "  launchctl unload \"$PLIST\" && rm \"$PLIST\""
echo ""

# Esegui subito un primo backup
echo "==> Eseguo primo backup di prova..."
bash "$INSTALL_DIR/mac-backup.sh"
tail -1 "$BACKUP_DIR/backup.log" 2>/dev/null || true
