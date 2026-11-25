#!/usr/bin/env bash
# Ensayo de restore: descifra un backup y lo restaura en un Postgres descartable
# (contenedor Docker que se borra al terminar). Nunca toca producción.
#
# Uso (en la PC, desde la raíz del repo):
#   scripts/backup/restore-test.sh <archivo.dump.gpg> [archivo-passphrase]
#
# Si no se pasa archivo de passphrase, gpg la pide por teclado.
# Imprime conteos de tablas clave y la última migración aplicada, y falla si la
# restauración tiene errores o si faltan las tablas principales.
set -euo pipefail

BACKUP="${1:?Uso: restore-test.sh <archivo.dump.gpg> [archivo-passphrase]}"
PASSFILE="${2:-}"
IMAGE="${RESTORE_TEST_IMAGE:-postgres:16-alpine}"
CONTAINER="finflow-restore-test-$$"
DB="finflow_restore"
KEY_TABLES=(users customers credits installments payments cash_sessions cash_accounts _migrations)

[[ -f "$BACKUP" ]] || { echo "No existe $BACKUP" >&2; exit 1; }

work="$(mktemp -d)"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

echo "→ Descifrando $(basename "$BACKUP")"
gpg_args=(--yes --quiet --decrypt --output "$work/db.dump")
if [[ -n "$PASSFILE" ]]; then
  gpg_args=(--batch --passphrase-file "$PASSFILE" "${gpg_args[@]}")
else
  gpg_args=(--pinentry-mode loopback "${gpg_args[@]}")
fi
gpg "${gpg_args[@]}" "$BACKUP"

echo "→ Levantando $IMAGE descartable"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=restore -e POSTGRES_DB="$DB" "$IMAGE" >/dev/null
# Por TCP: durante el init la imagen levanta un server temporal solo en el socket Unix,
# que pg_isready por socket daría como listo antes de tiempo.
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d "$DB" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d "$DB" >/dev/null || { echo "Postgres no arrancó" >&2; exit 1; }

echo "→ Restaurando"
started=$(date +%s)
# El dump entra por stdin (sin docker cp: Git Bash reescribe las rutas del contenedor).
# --exit-on-error: cualquier error de restauración hace fallar el ensayo.
docker exec -i "$CONTAINER" pg_restore --exit-on-error --no-owner -U postgres -d "$DB" < "$work/db.dump"
echo "  Restaurado en $(( $(date +%s) - started )) s"

q() { docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc "$1"; }

echo "→ Conteos de tablas clave"
missing=0
for t in "${KEY_TABLES[@]}"; do
  if [[ "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" != "t" ]]; then
    printf '  %-16s FALTA\n' "$t"; missing=1; continue
  fi
  printf '  %-16s %s\n' "$t" "$(q "SELECT count(*) FROM $t")"
done
echo "  Última migración: $(q "SELECT max(filename) FROM _migrations" 2>/dev/null || echo '?')"

(( missing == 0 )) || { echo "✗ Restore incompleto: faltan tablas" >&2; exit 1; }
echo "✓ Restore OK"
