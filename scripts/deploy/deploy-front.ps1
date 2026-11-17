# Deploy del frontend a produccion, desde esta PC.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy-front.ps1
# Opciones:
#   -FrontPath <ruta>   repo del front (default D:\gestion-creditos-f)
#   -SkipBuild          sube el dist existente sin volver a buildear
#   -AnyBranch          permite desplegar desde una rama distinta de main
#
# Pasos: build de produccion (npm run build, /api relativa) -> tgz -> scp -> publish-front.sh
# en el servidor (release nuevo + symlink atomico) -> verifica que el sitio sirva el build nuevo.
# Volver atras:  ssh creditos '~/apps/backend/scripts/deploy/publish-front.sh --rollback'
#
# Nota: archivo sin acentos a proposito (PowerShell 5.1 lee mal UTF-8 sin BOM).

param(
  [string]$FrontPath = 'D:\gestion-creditos-f',
  [string]$SshHost = 'creditos',
  [string]$Url = 'https://cg-service.online/',
  [switch]$SkipBuild,
  [switch]$AnyBranch
)

$ErrorActionPreference = 'Stop'

# Ejecutables de Windows con ruta fija: si el script se lanza desde Git Bash (por ejemplo con
# el "!" de Claude Code) el PATH trae primero los de Git, cuyo ssh no usa el ssh-agent de
# Windows y cuyo tar toma "D:" de la ruta como un host remoto.
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
$tar = "$env:WINDIR\System32\tar.exe"
foreach ($exe in @($ssh, $scp, $tar)) { if (-not (Test-Path $exe)) { Write-Host "ERROR: falta $exe" -ForegroundColor Red; exit 1 } }

$publish = '~/apps/backend/scripts/deploy/publish-front.sh'
$browserDir = Join-Path $FrontPath 'dist\gestion-creditos-f\browser'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# Devuelve el nombre del bundle main-*.js referenciado en un index.csr.html
function Get-MainBundle($html) {
  $m = [regex]::Match($html, 'main-[A-Za-z0-9]+\.js')
  if ($m.Success) { return $m.Value } else { return $null }
}

# -- Pre-chequeos ------------------------------------------------------------
if (-not (Test-Path (Join-Path $FrontPath 'package.json'))) { Fail "No encuentro el repo del front en $FrontPath" }

& $ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost true
if ($LASTEXITCODE -ne 0) { Fail "No hay acceso SSH a '$SshHost'. Si la clave tiene passphrase, correr: ssh-add" }

Push-Location $FrontPath
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $commit = (git log -1 --format='%h %s').Trim()
  $dirty = git status --porcelain --untracked-files=no
  Write-Host "Front: rama $branch - $commit"
  if ($branch -ne 'main' -and -not $AnyBranch) { Fail "El front esta en la rama '$branch'. Cambiar a main o usar -AnyBranch." }
  if ($dirty) { Write-Host "AVISO: el front tiene cambios sin commitear; se despliegan tal cual." -ForegroundColor Yellow }

  # -- Build -----------------------------------------------------------------
  if (-not $SkipBuild) {
    Step 'Build de produccion (npm run build)'
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'Fallo el build.' }
  }
} finally {
  Pop-Location
}

$indexLocal = Join-Path $browserDir 'index.csr.html'
if (-not (Test-Path $indexLocal)) { Fail "No existe $indexLocal (el build no genero el browser bundle)." }
$bundle = Get-MainBundle (Get-Content $indexLocal -Raw)

# -- Empaquetar y subir --------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tgz = Join-Path $env:TEMP "front-$stamp.tgz"
$remoteTgz = "/tmp/front-$stamp.tgz"

Step 'Empaquetando'
& $tar -czf $tgz -C $browserDir .
if ($LASTEXITCODE -ne 0) { Fail 'Fallo tar.' }

try {
  Step "Subiendo ($([math]::Round((Get-Item $tgz).Length / 1MB, 1)) MB)"
  & $scp -q -o BatchMode=yes $tgz "${SshHost}:$remoteTgz"
  if ($LASTEXITCODE -ne 0) { Fail 'Fallo scp.' }

  Step 'Publicando en el servidor'
  & $ssh -o BatchMode=yes $SshHost "$publish $remoteTgz"
  if ($LASTEXITCODE -ne 0) { Fail 'Fallo la publicacion en el servidor (el sitio sigue con el build anterior).' }
} finally {
  Remove-Item $tgz -ErrorAction SilentlyContinue
}

# -- Verificacion ------------------------------------------------------------
Step "Verificando $Url"
$resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers @{ 'Cache-Control' = 'no-cache' }
$bundleRemoto = Get-MainBundle $resp.Content
if ($bundle -and $bundleRemoto -ne $bundle) {
  Fail "El sitio sirve $bundleRemoto pero el build es $bundle."
}
Write-Host "OK: front desplegado ($bundle) - $commit" -ForegroundColor Green
