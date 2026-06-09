#!/bin/bash
# ============================================================
# GustoPro QR Logger — Backup script per Mac di JP
# ------------------------------------------------------------
# Scarica snapshot del log dal PC Windows del Riva e lo salva
# in ~/RivaBeach-QR-Backup/ (1 file per giorno + storico).
# Eseguito automaticamente ogni 30 min dal launchd plist.
# ============================================================
set -u  # no -e: non vogliamo morire se il PC e' irraggiungibile

CONFIG="$HOME/.gustopro-qr-backup.env"
BACKUP_DIR="$HOME/RivaBeach-QR-Backup"
LOG_FILE="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$CONFIG" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $CONFIG mancante. Lancia setup-mac-backup.sh prima." >> "$LOG_FILE"
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG"   # imposta PC_IP, ADMIN_KEY, PORT

PORT="${PORT:-3000}"
TS=$(date +%Y-%m-%d)
SNAPSHOT="$BACKUP_DIR/scans-$TS.jsonl"
TMP="$SNAPSHOT.tmp"

# Download snapshot (timeout 30s, fallisce silenziosamente se PC non raggiungibile)
if curl -fsS --max-time 30 \
      "http://${PC_IP}:${PORT}/export?key=${ADMIN_KEY}" \
      -o "$TMP" 2>>"$LOG_FILE"; then
  # Sostituisci atomicamente solo se il download e' andato a buon fine
  mv "$TMP" "$SNAPSHOT"
  LINES=$(wc -l < "$SNAPSHOT" | tr -d ' ')
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK $SNAPSHOT ($LINES righe)" >> "$LOG_FILE"
else
  rm -f "$TMP"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAIL: PC ${PC_IP}:${PORT} non raggiungibile" >> "$LOG_FILE"
  exit 0
fi

# Rotate del backup.log se > 1 MB
if [ -f "$LOG_FILE" ] && [ "$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv "$LOG_FILE" "$LOG_FILE.old"
fi
