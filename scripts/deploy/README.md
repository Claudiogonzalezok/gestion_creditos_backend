# Deploy a producción

Servidor: `ssh creditos` (DonWeb, usuario `deploy`). Sitio: https://cg-service.online

## Backend

```bash
ssh creditos '~/apps/backend/scripts/deploy/deploy-backend.sh'          # despliega origin/main
ssh creditos '~/apps/backend/scripts/deploy/deploy-backend.sh --ref X'  # otra rama de origin
```

Hace, en orden: backup de la base (`~/bin/backup-db.sh`) → `git merge --ff-only origin/<ref>` →
`pnpm install --frozen-lockfile --prod` (solo si cambió `package.json`, `pnpm-lock.yaml` o `pnpm-workspace.yaml`) → `pnpm run migration:run` →
`pm2 restart finflow-backend` → health check en `/api/health` (30 s).

- Si falla después de mover el código, vuelve solo al commit anterior y reinicia.
- **Las migraciones no se revierten.** Si una migración aplicada rompe algo, restaurar el dump
  que el script anotó en el log (`pg_restore`).
- Nunca corre seeds (en producción resetean el admin y cargan datos de prueba).
- Se niega a desplegar si hay cambios en archivos versionados del servidor, si hay menos de 1 GB
  libre o si `origin/<ref>` no avanza en línea recta (historia reescrita).
- Log: `~/deploys/backend.log`.

## Frontend

Desde la PC, en la raíz de este repo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy/deploy-front.ps1
```

(Con barras `/`: funciona igual en PowerShell y en el `!` de Claude Code, que corre en bash y se come las `\`.)

Buildea `D:\gestion-creditos-f` en modo producción (`pnpm run build`, con `API_BASE_URL` = `https://cg-service.online/api` inyectada por `scripts/set-api-url.mjs` del front, que después se restaura; si `environment.ts` tiene cambios sin commitear, el deploy se corta antes de buildear; si el bundle queda apuntando a `localhost:3000`, el deploy se corta antes de subir), sube el
contenido de `dist/gestion-creditos-f/browser` y lo publica con `publish-front.sh` como release
nuevo en `/var/www/creditos-app/releases/<fecha>`, activado con el symlink `current` (cambio atómico).
Al final verifica que el sitio sirva el `main-*.js` recién buildeado. Conserva los últimos 5 releases.

```bash
ssh creditos '~/apps/backend/scripts/deploy/publish-front.sh --list'      # releases (* = activo)
ssh creditos '~/apps/backend/scripts/deploy/publish-front.sh --rollback'  # volver al anterior
```

Opciones del `.ps1`: `-SkipBuild`, `-AnyBranch`, `-FrontPath <ruta>`.
Requiere la clave SSH en el agent (si la pide: `ssh-add`). Log: `~/deploys/front.log`.

## Preparación inicial del servidor (una sola vez)

Pasa el front de `/var/www/creditos` (directorio plano) al esquema de releases:

```bash
sudo mkdir -p /var/www/creditos-app/releases && sudo chown -R deploy:deploy /var/www/creditos-app
cp -a /var/www/creditos /var/www/creditos-app/releases/2026-11-12_inicial
ln -sfn /var/www/creditos-app/releases/2026-11-12_inicial /var/www/creditos-app/current
sudo sed -i 's#root /var/www/creditos;#root /var/www/creditos-app/current;#' /etc/nginx/sites-available/creditos
sudo nginx -t && sudo systemctl reload nginx
```

`/var/www/creditos` queda como respaldo hasta confirmar el primer deploy con el script.
