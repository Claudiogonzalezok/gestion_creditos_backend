// Unitarios de sesiones y bloqueo (#35, #42) con queries mockeadas.
// El comportamiento contra Postgres real se prueba en
// tests/integration/auth-sessions-lockout.test.js.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.mock("bcryptjs", () => ({
  hash: jest.fn(async () => "hash"),
  compare: jest.fn(),
}));
jest.mock("../../src/config/db", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../../src/modules/auth/auth.queries");
jest.mock("../../src/modules/users/users.queries");
jest.mock("../../src/modules/systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn(async () => null),
}));
jest.mock("../../src/utils/tempPassword", () => ({ generateTempPassword: () => "Temp1234" }));

process.env.JWT_SECRET_INTERNAL = "unit-internal";
process.env.JWT_SECRET_PORTAL = "unit-portal";

const bcrypt = require("bcryptjs");
const pool = require("../../src/config/db");
const authQueries = require("../../src/modules/auth/auth.queries");
const usersQueries = require("../../src/modules/users/users.queries");
const authService = require("../../src/modules/auth/auth.service");
const usersService = require("../../src/modules/users/users.service");

const caught = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

const future = () => new Date(Date.now() + 10 * 60 * 1000);
const past = () => new Date(Date.now() - 1000);

beforeEach(() => {
  jest.resetAllMocks();
  bcrypt.hash.mockResolvedValue("hash");
  authQueries.createRefreshToken.mockResolvedValue({});
});

describe("loginInternal", () => {
  const user = (o = {}) => ({
    id: "u1", dni: "1", role: "SELLER", status: "ACTIVE", password_hash: "h",
    failed_attempts: 0, locked_at: null, locked_until: null, ...o,
  });

  it("DNI inexistente: compara contra hash ficticio y responde genérico", async () => {
    authQueries.findUserByDni.mockResolvedValue(null);
    bcrypt.compare.mockResolvedValue(false);
    const err = await caught(authService.loginInternal("9", "x"));
    expect(err.status).toBe(401);
    expect(err.code).toBeUndefined();
    expect(bcrypt.compare).toHaveBeenCalled();
  });

  it("no-ADMIN bloqueado: ACCOUNT_LOCKED sin comparar contraseña", async () => {
    authQueries.findUserByDni.mockResolvedValue(user({ locked_at: new Date() }));
    const err = await caught(authService.loginInternal("1", "x"));
    expect(err.code).toBe("ACCOUNT_LOCKED");
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("ADMIN con bloqueo temporal vigente: ACCOUNT_TEMP_LOCKED con segundos restantes", async () => {
    authQueries.findUserByDni.mockResolvedValue(user({ role: "ADMIN", locked_until: future() }));
    const err = await caught(authService.loginInternal("1", "x"));
    expect(err.code).toBe("ACCOUNT_TEMP_LOCKED");
    expect(err.retry_after_seconds).toBeGreaterThan(500);
    expect(err.message).toMatch(/10 minutos/);
  });

  it("fallo que alcanza el umbral en no-ADMIN: bloquea y revoca refresh tokens", async () => {
    authQueries.findUserByDni.mockResolvedValue(user());
    bcrypt.compare.mockResolvedValue(false);
    authQueries.registerFailedAttempt.mockResolvedValue({ role: "SELLER", locked_at: new Date() });
    const err = await caught(authService.loginInternal("1", "x"));
    expect(err.code).toBe("ACCOUNT_LOCKED");
    expect(authQueries.registerFailedAttempt).toHaveBeenCalledWith("u1", 3, 15);
    expect(authQueries.revokeAllUserRefreshTokens).toHaveBeenCalledWith("u1");
  });

  it("fallo que alcanza el umbral en ADMIN: bloqueo temporal, nunca permanente", async () => {
    authQueries.findUserByDni.mockResolvedValue(user({ role: "ADMIN" }));
    bcrypt.compare.mockResolvedValue(false);
    authQueries.registerFailedAttempt.mockResolvedValue({ role: "ADMIN", locked_at: null, locked_until: future() });
    const err = await caught(authService.loginInternal("1", "x"));
    expect(err.code).toBe("ACCOUNT_TEMP_LOCKED");
    expect(authQueries.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("fallo bajo el umbral (bloqueo anterior vencido): genérico", async () => {
    authQueries.findUserByDni.mockResolvedValue(user({ role: "ADMIN", locked_until: past() }));
    bcrypt.compare.mockResolvedValue(false);
    authQueries.registerFailedAttempt.mockResolvedValue({ role: "ADMIN", locked_until: past() });
    const err = await caught(authService.loginInternal("1", "x"));
    expect(err.code).toBeUndefined();
  });

  it("login correcto resetea intentos y emite tokens", async () => {
    authQueries.findUserByDni.mockResolvedValue(user({ role: "ADMIN", locked_until: past() }));
    bcrypt.compare.mockResolvedValue(true);
    const r = await authService.loginInternal("1", "ok");
    expect(r.accessToken).toBeTruthy();
    expect(authQueries.resetFailedAttempts).toHaveBeenCalledWith("u1");
  });
});

describe("loginPortal", () => {
  const customer = (o = {}) => ({
    id: "c1", status: "ACTIVE", portal_enabled: true, portal_password_hash: "h",
    portal_locked_at: null, ...o,
  });

  it.each([
    ["inexistente", null],
    ["deshabilitado", { portal_enabled: false }],
    ["inactivo", { status: "INACTIVE" }],
  ])("cliente %s: mensaje genérico", async (_n, o) => {
    authQueries.findCustomerByDni.mockResolvedValue(o ? customer(o) : null);
    bcrypt.compare.mockResolvedValue(false);
    const err = await caught(authService.loginPortal("1", "x"));
    expect(err.message).toMatch(/DNI o contraseña incorrectos/);
  });

  it("bloqueado con contraseña mala: genérico y no incrementa", async () => {
    authQueries.findCustomerByDni.mockResolvedValue(customer({ portal_locked_at: new Date() }));
    bcrypt.compare.mockResolvedValue(false);
    const err = await caught(authService.loginPortal("1", "x"));
    expect(err.code).toBeUndefined();
    expect(authQueries.registerPortalFailedAttempt).not.toHaveBeenCalled();
  });

  it("bloqueado con contraseña correcta: ACCOUNT_LOCKED", async () => {
    authQueries.findCustomerByDni.mockResolvedValue(customer({ portal_locked_at: new Date() }));
    bcrypt.compare.mockResolvedValue(true);
    const err = await caught(authService.loginPortal("1", "ok"));
    expect(err.code).toBe("ACCOUNT_LOCKED");
  });

  it("fallo que bloquea: revoca refresh del cliente y responde genérico", async () => {
    authQueries.findCustomerByDni.mockResolvedValue(customer());
    bcrypt.compare.mockResolvedValue(false);
    authQueries.registerPortalFailedAttempt.mockResolvedValue({ portal_locked_at: new Date() });
    const err = await caught(authService.loginPortal("1", "x"));
    expect(err.message).toMatch(/DNI o contraseña incorrectos/);
    expect(authQueries.revokeAllCustomerRefreshTokens).toHaveBeenCalledWith("c1");
  });
});

describe("refresh", () => {
  const stored = (o = {}) => ({
    id: "rt1", family_id: "f1", user_id: "u1", customer_id: "c1",
    revoked: false, expires_at: future(), ...o,
  });

  it("token revocado: revoca la familia con SESSION_REVOKED", async () => {
    authQueries.findRefreshToken.mockResolvedValue(stored({ revoked: true }));
    const err = await caught(authService.refreshInternalToken("raw"));
    expect(err.code).toBe("SESSION_REVOKED");
    expect(authQueries.revokeFamilyRefreshTokens).toHaveBeenCalledWith("f1");
  });

  it("usuario bloqueado: 401 SESSION_REVOKED y revoca sus refresh", async () => {
    authQueries.findRefreshToken.mockResolvedValue(stored());
    pool.query.mockResolvedValue({ rows: [{ id: "u1", role: "SELLER", status: "ACTIVE", locked_at: new Date() }] });
    const err = await caught(authService.refreshInternalToken("raw"));
    expect(err.code).toBe("SESSION_REVOKED");
    expect(authQueries.revokeAllUserRefreshTokens).toHaveBeenCalledWith("u1");
  });

  it("rotación perdida (otro refresh ganó): REFRESH_TOKEN_ROTATED sin emitir token", async () => {
    authQueries.findRefreshToken.mockResolvedValue(stored());
    pool.query.mockResolvedValue({ rows: [{ id: "u1", role: "SELLER", status: "ACTIVE", locked_at: null }] });
    authQueries.revokeRefreshTokenIfActive.mockResolvedValue(false);
    const err = await caught(authService.refreshInternalToken("raw"));
    expect(err.code).toBe("REFRESH_TOKEN_ROTATED");
    expect(authQueries.createRefreshToken).not.toHaveBeenCalled();
  });

  it("portal: cliente bloqueado no renueva; rotación perdida responde REFRESH_TOKEN_ROTATED", async () => {
    authQueries.findRefreshToken.mockResolvedValue(stored());
    pool.query.mockResolvedValueOnce({
      rows: [{ id: "c1", status: "ACTIVE", portal_enabled: true, portal_locked_at: new Date() }],
    });
    expect((await caught(authService.refreshPortalToken("raw"))).code).toBe("SESSION_REVOKED");

    pool.query.mockResolvedValueOnce({
      rows: [{ id: "c1", status: "ACTIVE", portal_enabled: true, portal_locked_at: null }],
    });
    authQueries.revokeRefreshTokenIfActive.mockResolvedValue(false);
    expect((await caught(authService.refreshPortalToken("raw"))).code).toBe("REFRESH_TOKEN_ROTATED");
  });
});

describe("users.service · invalidación transaccional", () => {
  let client;
  beforeEach(() => {
    client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    pool.connect.mockResolvedValue(client);
  });

  it("resetPassword invalida sesiones dentro de la transacción", async () => {
    usersQueries.findById.mockResolvedValue({ id: "u1" });
    await usersService.resetPassword("u1");
    expect(usersQueries.resetPassword).toHaveBeenCalledWith("u1", "hash", client);
    expect(usersQueries.invalidateSessions).toHaveBeenCalledWith("u1", client);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
  });

  it("deactivate invalida sesiones dentro de la transacción", async () => {
    usersQueries.findById.mockResolvedValue({ id: "u1", role: "SELLER", status: "ACTIVE" });
    await usersService.deactivate("u1");
    expect(usersQueries.deactivate).toHaveBeenCalledWith("u1", client);
    expect(usersQueries.invalidateSessions).toHaveBeenCalledWith("u1", client);
  });

  it("cambio de rol: si falla el cierre de sesiones, hace ROLLBACK del rol", async () => {
    usersQueries.findById.mockResolvedValue({ id: "u1", role: "SELLER" });
    usersQueries.update.mockResolvedValue({ id: "u1", role: "COLLECTOR" });
    usersQueries.invalidateSessions.mockRejectedValue(new Error("boom"));
    const err = await caught(usersService.update("u1", { role: "COLLECTOR" }));
    expect(err.message).toBe("boom");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("update sin cambio de rol no abre transacción", async () => {
    usersQueries.findById.mockResolvedValue({ id: "u1", role: "SELLER" });
    usersQueries.update.mockResolvedValue({ id: "u1" });
    await usersService.update("u1", { full_name: "X" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
