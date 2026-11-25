// Sesiones y bloqueo de login (issues #42 y #35).
//   #42 · Bloquear / desactivar / resetear contraseña invalida access y refresh
//         previos; la rotación del refresh es atómica (solo un refresh gana).
//   #35 · ADMIN recibe bloqueo temporal (no permanente) tras N fallos; el conteo
//         de fallos es atómico; el login del portal no revela si el DNI existe.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const bcrypt = require("bcryptjs");
const { setupTestSuite, pool } = require("./helpers/db");
const { createUserFixture, createCustomerFixture } = require("./helpers/fixtures");

setupTestSuite();

const authService = require("../../src/modules/auth/auth.service");
const usersService = require("../../src/modules/users/users.service");
const { authenticate } = require("../../src/middlewares/auth.middleware");

const PASSWORD = "Secreta123";
let passwordHash;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

/**
 * Crea un usuario con contraseña conocida.
 * @returns {Promise<object>} usuario
 */
const userWithPassword = (overrides = {}) =>
  createUserFixture({ password_hash: passwordHash, ...overrides });

/**
 * Ejecuta el middleware authenticate con un Bearer y devuelve el status final.
 * @returns {Promise<number>} 200 si pasó, o el status de la respuesta
 */
const authStatus = (token) =>
  new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json() {
        resolve(this.code);
      },
    };
    authenticate(req, res, () => resolve(200));
  });

/** Ejecuta una promesa y devuelve el error lanzado (o null). */
const caught = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
};

describe("#42 · invalidación de sesiones", () => {
  it("No romper: login, refresh y logout normales funcionan", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);
    expect(await authStatus(login.accessToken)).toBe(200);

    const refreshed = await authService.refreshInternalToken(login.refreshTokenRaw);
    expect(refreshed.accessToken).toBeTruthy();
    expect(await authStatus(refreshed.accessToken)).toBe(200);

    const jwt = require("jsonwebtoken");
    await authService.logout(jwt.decode(refreshed.accessToken), false, refreshed.refreshTokenRaw);
    expect(await authStatus(refreshed.accessToken)).toBe(401);
    const err = await caught(authService.refreshInternalToken(refreshed.refreshTokenRaw));
    expect(err.status).toBe(401);
  });

  it("refresh con usuario bloqueado devuelve 401 y el access previo queda inválido", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);

    for (let i = 0; i < 3; i++) await caught(authService.loginInternal(u.dni, "mala"));
    const { rows } = await pool.query("SELECT locked_at FROM users WHERE id = $1", [u.id]);
    expect(rows[0].locked_at).not.toBeNull();

    const err = await caught(authService.refreshInternalToken(login.refreshTokenRaw));
    expect(err).toMatchObject({ status: 401, code: "SESSION_REVOKED" });
    expect(await authStatus(login.accessToken)).toBe(401);
  });

  it("refresh con locked_at puesto directamente en BD devuelve 401", async () => {
    const u = await userWithPassword({ role: "COLLECTOR" });
    const login = await authService.loginInternal(u.dni, PASSWORD);
    await pool.query("UPDATE users SET locked_at = NOW() WHERE id = $1", [u.id]);

    const err = await caught(authService.refreshInternalToken(login.refreshTokenRaw));
    expect(err).toMatchObject({ status: 401 });
  });

  it("resetear contraseña rechaza el access y el refresh anteriores", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);

    await usersService.resetPassword(u.id);

    expect(await authStatus(login.accessToken)).toBe(401);
    const err = await caught(authService.refreshInternalToken(login.refreshTokenRaw));
    expect(err).toMatchObject({ status: 401 });
  });

  it("desactivar rechaza el access y el refresh anteriores y revoca los refresh en BD", async () => {
    await userWithPassword({ role: "ADMIN" }); // otro admin activo
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);

    await usersService.deactivate(u.id);

    expect(await authStatus(login.accessToken)).toBe(401);
    const err = await caught(authService.refreshInternalToken(login.refreshTokenRaw));
    expect(err).toMatchObject({ status: 401 });
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked = FALSE",
      [u.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("cambio de rol invalida el access anterior (force relogin en la misma transacción)", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);

    const updated = await usersService.update(u.id, { role: "COLLECTOR" });
    expect(updated.role).toBe("COLLECTOR");
    expect(await authStatus(login.accessToken)).toBe(401);
  });

  it("dos refresh concurrentes con la misma cookie: solo uno obtiene token nuevo", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const login = await authService.loginInternal(u.dni, PASSWORD);

    const results = await Promise.allSettled([
      authService.refreshInternalToken(login.refreshTokenRaw),
      authService.refreshInternalToken(login.refreshTokenRaw),
      authService.refreshInternalToken(login.refreshTokenRaw),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    results
      .filter((r) => r.status === "rejected")
      .forEach((r) => expect(r.reason.status).toBe(401));

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1",
      [u.id],
    );
    expect(rows[0].n).toBe(2); // el original (revocado) + uno solo nuevo
  });

  it("refresh concurrente de portal: solo uno gana", async () => {
    const c = await createCustomerFixture();
    await pool.query(
      `UPDATE customers SET portal_enabled = TRUE, portal_password_hash = $2 WHERE id = $1`,
      [c.id, passwordHash],
    );
    const login = await authService.loginPortal(c.dni, PASSWORD);
    const results = await Promise.allSettled([
      authService.refreshPortalToken(login.refreshTokenRaw),
      authService.refreshPortalToken(login.refreshTokenRaw),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("#35 · bloqueo de login", () => {
  it("ADMIN: N+1 fallos generan bloqueo temporal; tras el tiempo, el login correcto funciona", async () => {
    const admin = await userWithPassword({ role: "ADMIN" });

    for (let i = 0; i < 4; i++) await caught(authService.loginInternal(admin.dni, "mala"));

    const { rows } = await pool.query(
      "SELECT locked_at, locked_until FROM users WHERE id = $1",
      [admin.id],
    );
    expect(rows[0].locked_at).toBeNull(); // nunca bloqueo permanente
    expect(new Date(rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());

    // Con la contraseña correcta sigue bloqueado mientras dure el bloqueo.
    const err = await caught(authService.loginInternal(admin.dni, PASSWORD));
    expect(err).toMatchObject({ status: 401, code: "ACCOUNT_TEMP_LOCKED" });
    expect(err.retry_after_seconds).toBeGreaterThan(0);

    // Control positivo: vencido el bloqueo, el login correcto funciona.
    await pool.query(
      "UPDATE users SET locked_until = NOW() - INTERVAL '1 second' WHERE id = $1",
      [admin.id],
    );
    const ok = await authService.loginInternal(admin.dni, PASSWORD);
    expect(ok.accessToken).toBeTruthy();
    const after = await pool.query(
      "SELECT failed_attempts, locked_until FROM users WHERE id = $1",
      [admin.id],
    );
    expect(after.rows[0]).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it("ADMIN: tras vencer el bloqueo, un fallo aislado no vuelve a bloquear", async () => {
    const admin = await userWithPassword({ role: "ADMIN" });
    for (let i = 0; i < 3; i++) await caught(authService.loginInternal(admin.dni, "mala"));
    await pool.query(
      "UPDATE users SET locked_until = NOW() - INTERVAL '1 second' WHERE id = $1",
      [admin.id],
    );
    const err = await caught(authService.loginInternal(admin.dni, "mala"));
    expect(err.code).toBeUndefined();
    const { rows } = await pool.query("SELECT locked_until FROM users WHERE id = $1", [admin.id]);
    expect(new Date(rows[0].locked_until).getTime()).toBeLessThan(Date.now());
  });

  it("no-ADMIN: el bloqueo sigue siendo permanente con code ACCOUNT_LOCKED", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    const errs = [];
    for (let i = 0; i < 3; i++) errs.push(await caught(authService.loginInternal(u.dni, "mala")));
    expect(errs[2]).toMatchObject({ status: 401, code: "ACCOUNT_LOCKED" });
    const err = await caught(authService.loginInternal(u.dni, PASSWORD));
    expect(err).toMatchObject({ status: 401, code: "ACCOUNT_LOCKED" });
  });

  it("N logins fallidos concurrentes dejan locked_at no nulo", async () => {
    const u = await userWithPassword({ role: "SELLER" });
    await Promise.allSettled(
      Array.from({ length: 5 }, () => authService.loginInternal(u.dni, "mala")),
    );
    const { rows } = await pool.query(
      "SELECT locked_at, failed_attempts FROM users WHERE id = $1",
      [u.id],
    );
    expect(rows[0].locked_at).not.toBeNull();
  });

  it("N logins fallidos concurrentes de portal bloquean al cliente", async () => {
    const c = await createCustomerFixture();
    await pool.query(
      `UPDATE customers SET portal_enabled = TRUE, portal_password_hash = $2 WHERE id = $1`,
      [c.id, passwordHash],
    );
    await Promise.allSettled(
      Array.from({ length: 5 }, () => authService.loginPortal(c.dni, "mala")),
    );
    const { rows } = await pool.query("SELECT portal_locked_at FROM customers WHERE id = $1", [c.id]);
    expect(rows[0].portal_locked_at).not.toBeNull();
  });

  it("portal: DNI inexistente, portal deshabilitado y contraseña mala devuelven el mismo mensaje", async () => {
    const disabled = await createCustomerFixture();
    const enabled = await createCustomerFixture();
    await pool.query(
      `UPDATE customers SET portal_enabled = TRUE, portal_password_hash = $2 WHERE id = $1`,
      [enabled.id, passwordHash],
    );

    const e1 = await caught(authService.loginPortal("99999999", PASSWORD));
    const e2 = await caught(authService.loginPortal(disabled.dni, PASSWORD));
    const e3 = await caught(authService.loginPortal(enabled.dni, "mala"));
    expect(e1.status).toBe(401);
    expect(e2.message).toBe(e1.message);
    expect(e3.message).toBe(e1.message);
  });
});
