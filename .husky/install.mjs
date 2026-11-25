// Instala los hooks de git en `npm ci` / `npm install`.
// En producción (`npm ci --omit=dev`, ver scripts/deploy) husky no está instalado:
// se omite sin error para no romper el deploy. En CI tampoco hace falta.
if (process.env.CI === 'true') process.exit(0);

let husky;
try {
  husky = (await import('husky')).default;
} catch {
  process.exit(0);
}
const message = husky();
if (message) console.warn(message);
