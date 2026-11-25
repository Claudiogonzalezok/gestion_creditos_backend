// Issues #52 y #53 — el setup de la base es re-ejecutable.
//   · Correr el runner de migraciones dos veces sobre una BD vacía no falla
//     ni aplica nada la segunda vez.
//   · Correr las semillas dos veces no cambia contraseñas ni duplica datos.
//   · Las semillas abortan con NODE_ENV=production.
//   · Las planillas no se pueden borrar físicamente (migración 051).
// Usa una base descartable propia (sufijo _test) en el mismo servidor de test,
// para no interferir con la DB compartida del resto de la suite.

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { Pool } = require("pg");

const { loadTestEnv } = require("./helpers/testDbGuard");

loadTestEnv();

const ROOT = path.join(__dirname, "../..");
const FRESH_DB = `p27_setup_${process.pid}_test`;
const MIGRATIONS_DIR = path.join(ROOT, "src/config/migrations");

const connect = (database) =>
  new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

/**
 * Ejecuta un script node contra la base descartable.
 * @param {string} script - ruta relativa al root del repo
 * @param {Object} extraEnv - variables adicionales
 */
const runScript = (script, extraEnv = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, DB_NAME: FRESH_DB, ...extraEnv },
    encoding: "utf8",
    timeout: 180000,
  });

// Tablas de datos que las semillas cargan.
const COUNTED_TABLES = [
  "users",
  "customers",
  "credits",
  "installments",
  "payments",
  "collection_sheets",
  "system_config",
  "interest_rates",
];

const snapshot = async (pool) => {
  const counts = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = Number(
      (await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n,
    );
  }
  const users = (
    await pool.query("SELECT dni, password_hash FROM users ORDER BY dni")
  ).rows;
  return { counts, users };
};

let admin;
let fresh;

beforeAll(async () => {
  admin = connect("postgres");
  await admin.query(`DROP DATABASE IF EXISTS "${FRESH_DB}" WITH (FORCE)`);
});

afterAll(async () => {
  if (fresh) await fresh.end();
  await admin.query(`DROP DATABASE IF EXISTS "${FRESH_DB}" WITH (FORCE)`);
  await admin.end();
}, 60000);

describe("setup re-ejecutable (issues #52 y #53)", () => {
  test("migraciones dos veces sobre BD vacía: sin errores y sin re-aplicar", async () => {
    const first = runScript("src/scripts/migration.run.js");
    expect(first.stderr).not.toMatch(/Error/);
    expect(first.status).toBe(0);

    const second = runScript("src/scripts/migration.run.js");
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/No hay migraciones nuevas/);

    fresh = connect(FRESH_DB);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const { rows } = await fresh.query("SELECT COUNT(*) AS n FROM _migrations");
    expect(Number(rows[0].n)).toBe(files.length);
  }, 200000);

  test("semillas abortan con NODE_ENV=production sin tocar datos", async () => {
    const res = runScript("src/seeds/index.seed.js", { NODE_ENV: "production" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/NODE_ENV=production/);
    const { rows } = await fresh.query("SELECT COUNT(*) AS n FROM users");
    expect(Number(rows[0].n)).toBe(0);
  }, 60000);

  test("semillas dos veces: no cambian contraseñas ni duplican datos", async () => {
    const first = runScript("src/seeds/index.seed.js");
    expect(first.status).toBe(0);
    const before = await snapshot(fresh);
    expect(before.counts.users).toBeGreaterThan(0);

    const second = runScript("src/seeds/index.seed.js");
    expect(second.status).toBe(0);
    const after = await snapshot(fresh);

    expect(after.users).toEqual(before.users);
    expect(after.counts).toEqual(before.counts);

    const usersOnly = runScript("src/seeds/seed-users-only.js");
    expect(usersOnly.status).toBe(0);
    expect((await snapshot(fresh)).users).toEqual(before.users);
  }, 400000);

  test("planillas: DELETE físico rechazado (051)", async () => {
    const { rows } = await fresh.query(
      "SELECT COUNT(*) AS n FROM collection_sheets",
    );
    if (Number(rows[0].n) === 0) {
      const user = (await fresh.query("SELECT id FROM users LIMIT 1")).rows[0];
      await fresh.query(
        `INSERT INTO collection_sheets (collector_id, sheet_date, generated_by)
         VALUES ($1, CURRENT_DATE, $1)`,
        [user.id],
      );
    }
    await expect(fresh.query("DELETE FROM collection_sheets")).rejects.toThrow(
      /inmutables/,
    );
    const after = await fresh.query("SELECT COUNT(*) AS n FROM collection_sheets");
    expect(Number(after.rows[0].n)).toBeGreaterThan(0);
  });
});
