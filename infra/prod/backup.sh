#!/bin/sh
# Backup diário: dump do Postgres + imagens. Mantém BACKUP_KEEP_DAYS dias.
set -eu
run() {
  stamp=$(date +%Y-%m-%d_%H%M)
  pg_dump -Fc -f "/backups/db_${stamp}.dump.tmp" && mv "/backups/db_${stamp}.dump.tmp" "/backups/db_${stamp}.dump"
  tar -czf "/backups/media_${stamp}.tar.gz" -C /media .
  find /backups -name 'db_*.dump' -mtime +"${BACKUP_KEEP_DAYS}" -delete
  find /backups -name 'media_*.tar.gz' -mtime +"${BACKUP_KEEP_DAYS}" -delete
  echo "$(date -Iseconds) backup ok: ${stamp}"
}
[ "${1:-}" = "now" ] && { run; exit 0; }
echo "backup agendado para ${BACKUP_HOUR}h"
while true; do
  if [ "$(date +%H)" -eq "${BACKUP_HOUR}" ] && [ ! -f "/backups/.done_$(date +%Y-%m-%d)" ]; then
    run && rm -f /backups/.done_* && touch "/backups/.done_$(date +%Y-%m-%d)"
  fi
  sleep 300
done
