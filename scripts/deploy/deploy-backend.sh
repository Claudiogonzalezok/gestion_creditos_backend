#!/usr/bin/env bash
# Deploy del backend en el servidor de producción.
#
# Uso (desde la PC):  ssh creditos '~/apps/backend/scripts/deploy/deploy-backend.sh'
# Opciones:
#   --ref <rama>   rama de origin a desplegar (default: main)
#   --force        reinicia aunque no haya commits nuevos
#
# Pasos: backup de la base → fast-forward a origin/<ref> → pnpm install (solo si cambió
# el lock) → migraciones → restart PM2 → health check. Si algo falla después de
# mover el código, vuelve solo al commit anterior. Las migraciones NO se revierten:
# si una migración ya aplicada rompe algo, restaurar el dump de pre-deploy.
#
# NUNCA corre seeds: en producción resetean el admin y cargan datos de prueba.
set -euo pipefail

# Bash lee el script a medida que lo ejecuta: como `git merge` puede reescribir
# este mismo archivo, se re-ejecuta desde una copia temporal.
if [[ -z "${DEPLOY_REEXEC:-}" ]]; then
  tmp="$(mktemp /tmp/deploy-backend.XXXXXX.sh)"
  cp "$0" "$tmp"
  DEPLOY_REEXEC=1 DEPLOY_SELF="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$DEPLOY_SELF"' EXIT

APP_DIR="$HOME/apps/backend"
PM2_NAME="finflow-backend"
HEALTH_URL="http://127.0.0.1:3000/api/health"
BACKUP_SCRIPT="$HOME/bin/backup-db.sh"
LOG_FILE="$HOME/deploys/backend.log"
LOCK_FILE="/tmp/deploy-backend.lock"

REF="main"
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)   REF="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "$(date '+%F %T') $*" | tee -a "$LOG_FILE"; }
fail() { log "❌ $*"; exit 1; }

# Un solo deploy a la vez
exec 9>"$LOCK_FILE"
flock -n 9 || fail "Ya hay un deploy en curso."

cd "$APP_DIR"

# ── Pre-chequeos ─────────────────────────────────────────────────────────────
git diff --quiet HEAD -- || fail "Hay cambios locales en archivos versionados del servidor. Revisar con 'git status'."
[[ -f .env ]] || fail "Falta $APP_DIR/.env"
free_mb=$(df -Pm "$HOME" | awk 'NR==2 {print $4}')
(( free_mb > 1024 )) || fail "Menos de 1 GB libre en disco (${free_mb} MB)."

git fetch --quiet origin "$REF"
PREV="$(git rev-parse HEAD)"
NEXT="$(git rev-parse "origin/$REF")"

if [[ "$PREV" == "$NEXT" && "$FORCE" -eq 0 ]]; then
  log "✔️  Nada para desplegar: ya está en $(git log -1 --format='%h %s' HEAD)"
  exit 0
fi

git merge-base --is-ancestor "$PREV" "$NEXT" \
  || fail "origin/$REF no avanza en línea recta desde $(git rev-parse --short "$PREV") (¿historia reescrita?). Resolver a mano."

log "▶️  Deploy $REF: $(git rev-parse --short "$PREV") → $(git rev-parse --short "$NEXT")"
git log --format='     %h %s' "$PREV..$NEXT" | tee -a "$LOG_FILE"

# ── Backup previo (el mismo script del cron diario) ──────────────────────────
log "💾 Backup de la base antes de desplegar"
"$BACKUP_SCRIPT" | tee -a "$LOG_FILE"

# ── Rollback de código ante cualquier falla a partir de acá ──────────────────
deps_changed=0

# Instala dependencias de producción con el gestor del commit actual: pnpm si hay
# pnpm-lock.yaml; npm si el rollback vuelve a un commit previo a la migración (#60).
# CI=true evita que pnpm pida confirmación (sin TTY) al reemplazar un node_modules de npm.
install_deps() {
  if [[ -f pnpm-lock.yaml ]]; then
    CI=true pnpm install --frozen-lockfile --prod
  else
    npm ci --omit=dev --no-audit --no-fund
  fi
}

rollback() {
  log "↩️  Falla: volviendo a $(git rev-parse --short "$PREV")"
  git reset --quiet --hard "$PREV"
  if (( deps_changed )); then install_deps >>"$LOG_FILE" 2>&1 || true; fi
  pm2 restart "$PM2_NAME" --update-env >/dev/null || true
  log "↩️  Código revertido. Si se aplicó alguna migración, NO se deshizo: evaluar restaurar el dump de arriba."
}
trap 'rollback; rm -f "$DEPLOY_SELF"' ERR

git merge --quiet --ff-only "$NEXT"

if ! git diff --quiet "$PREV" "$NEXT" -- package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml; then
  deps_changed=1
  log "📦 Cambiaron las dependencias: pnpm install --frozen-lockfile --prod"
  install_deps >>"$LOG_FILE" 2>&1
fi

log "🗄️  Migraciones"
pnpm run --silent migration:run 2>&1 | grep -E '▶️|✅|❌|🎉|✔️' | tee -a "$LOG_FILE"

log "🔄 Reiniciando $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env >/dev/null

# Health check: hasta 30 s para que levante
for _ in $(seq 1 15); do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    trap - ERR
    log "✅ Deploy OK: $(git log -1 --format='%h %s' HEAD)"
    exit 0
  fi
done

log "❌ $HEALTH_URL no respondió en 30 s. Últimas líneas de error:"
pm2 logs "$PM2_NAME" --err --lines 20 --nostream 2>&1 | tail -20 | tee -a "$LOG_FILE"
false
