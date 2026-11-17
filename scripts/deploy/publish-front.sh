#!/usr/bin/env bash
# Publica en el servidor un build del front ya subido (lo invoca deploy-front.ps1).
#
# Uso:
#   publish-front.sh <archivo.tgz>   extrae el build como release nuevo y lo activa
#   publish-front.sh --rollback      vuelve al release anterior
#   publish-front.sh --list          lista los releases (el activo marcado con *)
#
# Estructura: /var/www/creditos-app/releases/<fecha>/  +  current -> releases/<fecha>
# Nginx sirve root /var/www/creditos-app/current. El cambio de symlink es atómico
# (rename), así que nadie ve un build a medio copiar.
set -euo pipefail

BASE="${FRONT_BASE:-/var/www/creditos-app}"   # overridable solo para probar el script
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
KEEP=5
LOG_FILE="${FRONT_LOG:-$HOME/deploys/front.log}"

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "$(date '+%F %T') $*" | tee -a "$LOG_FILE"; }
fail() { log "❌ $*"; exit 1; }

[[ -d "$RELEASES" ]] || fail "No existe $RELEASES (falta la preparación inicial del servidor)."

activate() {
  ln -sfn "$1" "$CURRENT.tmp"
  mv -T "$CURRENT.tmp" "$CURRENT"
}
active_release() { readlink -f "$CURRENT" 2>/dev/null || true; }

case "${1:-}" in
  --list)
    act="$(active_release)"
    for d in $(ls -1d "$RELEASES"/*/ | sort); do
      d="${d%/}"; [[ "$d" == "$act" ]] && echo "* $(basename "$d")" || echo "  $(basename "$d")"
    done
    exit 0
    ;;
  --rollback)
    act="$(active_release)"
    prev="$(ls -1d "$RELEASES"/*/ | sed 's#/$##' | sort | awk -v a="$act" '$0==a {print last; exit} {last=$0}')"
    [[ -n "$prev" ]] || fail "No hay un release anterior a $(basename "$act")."
    activate "$prev"
    log "↩️  Front revertido: $(basename "$act") → $(basename "$prev")"
    exit 0
    ;;
  ""|-*)
    echo "Uso: $0 <archivo.tgz> | --rollback | --list" >&2; exit 2 ;;
esac

TGZ="$1"
[[ -f "$TGZ" ]] || fail "No existe $TGZ"

STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$RELEASES/$STAMP"
mkdir "$DEST"
tar -xzf "$TGZ" -C "$DEST"

# El build con SSR/prerender no trae index.html: Nginx sirve index.csr.html
if [[ ! -f "$DEST/index.csr.html" ]]; then
  rm -rf "$DEST"
  fail "El paquete no trae index.csr.html: ¿es el contenido de dist/gestion-creditos-f/browser?"
fi

activate "$DEST"
rm -f "$TGZ"
log "✅ Front publicado: $STAMP ($(du -sh "$DEST" | cut -f1))"

# Rotación: conserva los últimos $KEEP releases (nunca borra el activo)
act="$(active_release)"
ls -1d "$RELEASES"/*/ | sed 's#/$##' | sort | head -n -"$KEEP" | while read -r old; do
  [[ "$old" == "$act" ]] || rm -rf "$old"
done
