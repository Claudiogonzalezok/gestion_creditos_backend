#!/usr/bin/env bash
# Backup diario de la base de producción de finFlow.
#
# Uso (en el VPS, como root, normalmente desde cron):
#   /opt/finflow-backup/backup-db.sh             # dump + cifrado + subida + retención
#   /opt/finflow-backup/backup-db.sh --no-upload # solo local (pruebas)
#
# Pasos: pg_dump -Fc → verificación con pg_restore --list → cifrado simétrico
# con gpg (AES256) → copia a Google Drive con rclone → retención local y remota.
# Lo único que se ejecuta contra la base es pg_dump (lectura).
#
# Configuración: /etc/finflow-backup.env (ver docs/backups.md). Variables:
#   DB_NAME           base a respaldar (default: finflow)
#   PG_AS_USER        usuario del sistema con el que corre pg_dump (default: postgres;
#                     vacío = el usuario actual, usando PGHOST/PGPORT/PGUSER del entorno)
#   BACKUP_DIR        carpeta local (default: /var/backups/finflow)
#   PASSPHRASE_FILE   archivo con la passphrase de cifrado, permisos 600
#   RCLONE_REMOTE     destino rclone, p. ej. gdrive:finflow-backups
#   KEEP_LOCAL_DAYS   días que se guardan en el VPS (default: 7)
#   KEEP_REMOTE_DAYS  días que se guardan en Drive (default: 30)
set -euo pipefail

CONFIG_FILE="${BACKUP_CONFIG:-/etc/finflow-backup.env}"
# shellcheck source=/dev/null
[[ -f "$CONFIG_FILE" ]] && source "$CONFIG_FILE"

DB_NAME="${DB_NAME:-finflow}"
PG_AS_USER="${PG_AS_USER-postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/finflow}"
PASSPHRASE_FILE="${PASSPHRASE_FILE:-/root/.finflow-backup-passphrase}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
KEEP_REMOTE_DAYS="${KEEP_REMOTE_DAYS:-30}"
LOG_FILE="${BACKUP_LOG:-/var/log/finflow-backup.log}"

UPLOAD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-upload) UPLOAD=0; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG_FILE"; }
fail() { log "ERROR: $*"; exit 1; }

# Corre un comando de Postgres como PG_AS_USER (peer auth) o como el usuario actual.
pg() {
  if [[ -n "$PG_AS_USER" ]]; then sudo -u "$PG_AS_USER" "$@"; else "$@"; fi
}

[[ -s "$PASSPHRASE_FILE" ]] || fail "Falta la passphrase en $PASSPHRASE_FILE"
if (( UPLOAD )); then
  [[ -n "$RCLONE_REMOTE" ]] || fail "RCLONE_REMOTE vacío: sin copia fuera del VPS no hay backup (usar --no-upload solo para pruebas)"
  command -v rclone >/dev/null || fail "rclone no está instalado"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Un solo backup a la vez.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || fail "Ya hay un backup en curso"

stamp="$(date '+%F_%H%M')"
final="$BACKUP_DIR/${DB_NAME}_${stamp}.dump.gpg"
tmp_dump="$(mktemp "$BACKUP_DIR/.tmp.XXXXXX")"
trap 'rm -f "$tmp_dump"' EXIT

log "Backup de $DB_NAME → $final"

# pg_dump escribe por stdout: el archivo temporal queda en manos de root.
pg pg_dump --format=custom --no-owner --dbname="$DB_NAME" > "$tmp_dump" \
  || fail "pg_dump falló"

# Un dump que pg_restore no puede listar está corrupto: no se guarda.
pg_restore --list "$tmp_dump" > /dev/null || fail "El dump no es legible por pg_restore"

gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
  --passphrase-file "$PASSPHRASE_FILE" --output "$final" "$tmp_dump" \
  || fail "Cifrado con gpg falló"
chmod 600 "$final"
log "OK local: $(du -h "$final" | cut -f1)"

if (( UPLOAD )); then
  rclone copy "$final" "$RCLONE_REMOTE" || fail "Subida a $RCLONE_REMOTE falló (el backup local quedó en $final)"
  log "OK remoto: $RCLONE_REMOTE/$(basename "$final")"
  rclone delete "$RCLONE_REMOTE" --min-age "${KEEP_REMOTE_DAYS}d" --include "${DB_NAME}_*.dump.gpg" \
    || log "AVISO: no se pudo aplicar la retención remota"
fi

find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}_*.dump.gpg" -mtime +"$KEEP_LOCAL_DAYS" -delete
log "Listo"
