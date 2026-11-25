# Backups de la base de producción

Producción: VPS DonWeb (`api.productcred.com.ar`), Postgres 16 nativo, base `finflow`.

| | |
|---|---|
| **Qué** | `pg_dump -Fc` de `finflow`, cifrado con gpg (AES256, passphrase) |
| **Cuándo** | Todos los días a las 03:00 (cron de root) |
| **Dónde** | `/var/backups/finflow` en el VPS (7 días) + Google Drive `finflow-backups` (30 días) |
| **RPO** | 24 h: en el peor caso se pierde lo cargado desde el último backup |
| **RTO** | ~1 h: bajar el dump, descifrar, restaurar, reiniciar la app |

Scripts: [`scripts/backup/backup-db.sh`](../scripts/backup/backup-db.sh) (VPS) y
[`scripts/backup/restore-test.sh`](../scripts/backup/restore-test.sh) (PC, Docker).

> **La passphrase es la única forma de abrir los backups.** Si se pierde, los backups no sirven.
> Guardala en un gestor de contraseñas, fuera del VPS.

## Instalación en el VPS (una sola vez, como root)

1. Copiar el script y crear la passphrase:

   ```bash
   mkdir -p /opt/finflow-backup
   cp <repo>/scripts/backup/backup-db.sh /opt/finflow-backup/ && chmod 700 /opt/finflow-backup/backup-db.sh
   apt install -y rclone gnupg
   openssl rand -base64 32 > /root/.finflow-backup-passphrase && chmod 600 /root/.finflow-backup-passphrase
   cat /root/.finflow-backup-passphrase   # copiarla al gestor de contraseñas
   ```

2. Conectar Google Drive. El VPS no tiene navegador: el token se genera en la PC.

   ```bash
   # En la PC (con rclone instalado): abre el navegador y devuelve un token JSON
   rclone authorize "drive"
   # En el VPS: crear el remote "gdrive" pegando ese token
   rclone config create gdrive drive scope=drive.file config_token='<token JSON>'
   rclone mkdir gdrive:finflow-backups
   ```

   `scope=drive.file` limita a rclone a los archivos que él mismo crea: no ve el resto del Drive.

3. Configuración en `/etc/finflow-backup.env` (`chmod 600`):

   ```bash
   DB_NAME=finflow
   PG_AS_USER=postgres
   RCLONE_REMOTE=gdrive:finflow-backups
   KEEP_LOCAL_DAYS=7
   KEEP_REMOTE_DAYS=30
   HEALTHCHECK_URL=https://hc-ping.com/<uuid>   # ver paso 5
   ```

4. Primera corrida a mano y cron:

   ```bash
   /opt/finflow-backup/backup-db.sh && rclone ls gdrive:finflow-backups
   ( crontab -l 2>/dev/null; echo '0 3 * * * /opt/finflow-backup/backup-db.sh' ) | crontab -
   ```

5. Aviso si el backup deja de correr: crear un check gratis en [healthchecks.io](https://healthchecks.io)
   (período 1 día, gracia 2 h, aviso por mail) y poner su URL en `HEALTHCHECK_URL`. El script
   lo pinguea al terminar bien y pinguea `/fail` al fallar; si un día no llega nada, también avisa.

Log: `/var/log/finflow-backup.log`. Una corrida buena termina en `Listo`; una con error deja
`ERROR: ...` (también las fallas inesperadas). Desde cron, todo lo que imprimen pg_dump, gpg y rclone va al mismo log.

## Verificar que el backup corre

```bash
tail -5 /var/log/finflow-backup.log
rclone ls gdrive:finflow-backups | sort -k2 | tail -3
```

## Ensayo de restore (no toca producción)

En la PC, con Docker y gpg (Git Bash trae gpg):

1. Bajar el último `finflow_*.dump.gpg` desde Google Drive.
2. Desde la raíz del repo:

   ```bash
   bash scripts/backup/restore-test.sh ~/Downloads/finflow_AAAA-MM-DD_HHMM.dump.gpg
   ```

   Pide la passphrase, restaura en un Postgres 16 descartable y muestra los conteos de tablas clave
   y la última migración. Termina en `✓ Restore OK` o falla con el motivo. El contenedor se borra al final.
3. Comparar los conteos con lo que muestra la app (clientes, créditos) y anotar el ensayo abajo.

## Restaurar producción (emergencia)

Solo si la base de producción se perdió o se corrompió. Restaurar en una base nueva y recién
después cambiarla, así la base vieja queda para analizar.

Como root. El bloque corta en el primer error (no renombra nada si el restore falló). El dump
descifrado queda en una carpeta privada (solo root y postgres) y se borra al terminar. No se
restaura desde un pipe: `pg_restore` necesita poder saltar dentro del archivo.

```bash
export BACKUP=/var/backups/finflow/finflow_<fecha>.dump.gpg   # o el bajado de Drive
export BROKEN="finflow_broken_$(date +%Y%m%d_%H%M)"
bash -euo pipefail <<'EOF'
umask 077
work="$(mktemp -d -p /var/backups)"; trap 'rm -rf "$work"' EXIT
chown postgres "$work"
gpg --batch --decrypt --passphrase-file /root/.finflow-backup-passphrase --output "$work/db.dump" "$BACKUP"
chown postgres "$work/db.dump"
pm2 stop finflow-backend
sudo -u postgres dropdb --if-exists finflow_restored
sudo -u postgres createdb -O finflow_user finflow_restored
sudo -u postgres pg_restore --exit-on-error --no-owner --role=finflow_user -d finflow_restored "$work/db.dump"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE finflow RENAME TO $BROKEN"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE finflow_restored RENAME TO finflow"
pm2 start finflow-backend
EOF
```

Si falla antes del primer `RENAME`, producción sigue intacta: `pm2 start finflow-backend` y revisar.
El `RENAME` de `finflow` falla si quedan conexiones abiertas: cerrarlas (o esperar) y repetir.

Todo lo cargado después del backup se pierde (RPO): avisar a quien opere el sistema.

## Registro de ensayos

| Fecha | Backup usado | Resultado | Quién |
|---|---|---|---|
| 2026-11-25 | Base de test (ensayo del script, no producción) | OK, restore en 3 s | — |
