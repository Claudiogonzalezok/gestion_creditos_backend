// Integración — recuperación de contraseña por token (issue #88).
//   · Misma respuesta exista o no el usuario.
//   · Token de un solo uso, guardado hasheado, con vencimiento.
//   · El reseteo cierra todas las sesiones del usuario.
//   · Límite de intentos por IP.
//   · Sin transporte de notificaciones → 503 sin revelar nada.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

process.env.PASSWORD_RESET_RATE_LIMIT_MAX = "3";

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../../src/app");
const { pool, setupTestSuite, setConfig } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const notifier = require("../../src/modules/notifications/notifier");
const { hashToken } = require("../../src/modules/auth/passwordReset.service");

setupTestSuite();

// Cada test usa su propia IP (trust proxy loopback) para no compartir el límite.
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;

const forgot = (email, ip = nextIp()) =>
  request(app).post("/api/auth/forgot-password").set("X-Forwarded-For", ip).send({ email });
const reset = (token, new_password, ip = nextIp()) =>
  request(app).post("/api/auth/reset-password").set("X-Forwarded-For", ip).send({ token, new_password });

const createUserWithEmail = async (email, overrides = {}) => {
  const user = await createUserFixture(overrides);
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, user.id]);
  return user;
};

/** Extrae el token del último email del outbox. */
const lastToken = () => {
  const msg = notifier.outbox[notifier.outbox.length - 1];
  return msg.text.match(/token=([A-Za-z0-9_-]+)/)[1];
};

const savedTransport = process.env.NOTIFIER_TRANSPORT;
beforeEach(() => {
  notifier.clearOutbox();
  delete process.env.NOTIFIER_TRANSPORT;
});
afterAll(() => {
  if (savedTransport === undefined) delete process.env.NOTIFIER_TRANSPORT;
  else process.env.NOTIFIER_TRANSPORT = savedTransport;
});

describe("POST /api/auth/forgot-password", () => {
  it("responde igual exista o no el usuario y solo envía email al existente", async () => {
    const user = await createUserWithEmail("ana@empresa.com", { role: "COLLECTOR" });

    const existing = await forgot("ANA@empresa.com");
    const missing = await forgot("nadie@empresa.com");

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    expect(existing.body).toEqual(missing.body);
    expect(notifier.outbox).toHaveLength(1);
    expect(notifier.outbox[0].to).toBe("ana@empresa.com");

    const tokens = await pool.query(`SELECT user_id, token_hash, expires_at, used_at FROM password_reset_tokens`);
    expect(tokens.rows).toHaveLength(1);
    expect(tokens.rows[0].user_id).toBe(user.id);
    // Se guarda el hash, nunca el token en claro.
    const token = lastToken();
    expect(tokens.rows[0].token_hash).toBe(hashToken(token));
    expect(tokens.rows[0].token_hash).not.toContain(token);
  });

  it("no envía a usuarios inactivos (misma respuesta)", async () => {
    await createUserWithEmail("baja@empresa.com", { status: "INACTIVE" });
    const res = await forgot("baja@empresa.com");
    expect(res.status).toBe(200);
    expect(notifier.outbox).toHaveLength(0);
  });

  it("usa el vencimiento de system_config (password_reset_expiry_min)", async () => {
    await setConfig("password_reset_expiry_min", 10);
    await createUserWithEmail("ven@empresa.com");
    await forgot("ven@empresa.com");
    const r = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS secs FROM password_reset_tokens`,
    );
    expect(r.rows[0].secs).toBe(600);
  });

  it("un pedido nuevo invalida el token anterior", async () => {
    await createUserWithEmail("dos@empresa.com");
    await forgot("dos@empresa.com");
    const first = lastToken();
    await forgot("dos@empresa.com");
    const res = await reset(first, "nuevaClave1");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_RESET_TOKEN");
  });

  it("valida el email con 400", async () => {
    const res = await forgot("no-es-email");
    expect(res.status).toBe(400);
  });

  it("sin transporte configurado responde 503 NOTIFIER_NOT_CONFIGURED sin crear tokens", async () => {
    process.env.NOTIFIER_TRANSPORT = "disabled";
    await createUserWithEmail("x@empresa.com");
    const existing = await forgot("x@empresa.com");
    const missing = await forgot("y@empresa.com");
    expect(existing.status).toBe(503);
    expect(existing.body.code).toBe("NOTIFIER_NOT_CONFIGURED");
    expect(missing.body).toEqual(existing.body);
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens`);
    expect(r.rows[0].n).toBe(0);
  });

  it("limita los intentos por IP con 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await forgot("a@b.com", ip)).status).toBe(200);
    const res = await forgot("a@b.com", ip);
    expect(res.status).toBe(429);
    expect(res.body.ok).toBe(false);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("cambia la contraseña, consume el token y cierra todas las sesiones", async () => {
    const user = await createUserWithEmail("eva@empresa.com", { is_temp_password: true });
    await pool.query(
      `INSERT INTO refresh_tokens (token, family_id, user_id, expires_at)
       VALUES ('rt-hash-eva', gen_random_uuid(), $1, NOW() + INTERVAL '7 days')`,
      [user.id],
    );
    await forgot("eva@empresa.com");
    const token = lastToken();

    const res = await reset(token, "nuevaClave1");
    expect(res.status).toBe(200);

    const u = await pool.query(
      `SELECT password_hash, is_temp_password, force_relogin_at FROM users WHERE id = $1`,
      [user.id],
    );
    expect(await bcrypt.compare("nuevaClave1", u.rows[0].password_hash)).toBe(true);
    expect(u.rows[0].is_temp_password).toBe(false);
    expect(u.rows[0].force_relogin_at).not.toBeNull();
    const rt = await pool.query(`SELECT revoked FROM refresh_tokens WHERE user_id = $1`, [user.id]);
    expect(rt.rows.every((r) => r.revoked)).toBe(true);

    // Un solo uso.
    const again = await reset(token, "otraClave2");
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rechaza un token vencido", async () => {
    await createUserWithEmail("old@empresa.com");
    await forgot("old@empresa.com");
    await pool.query(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute'`);
    const res = await reset(lastToken(), "nuevaClave1");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_RESET_TOKEN");
  });

  it("rechaza un token inexistente y una contraseña débil", async () => {
    expect((await reset("inventado", "nuevaClave1")).status).toBe(400);
    const weak = await reset("inventado", "corta");
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBeUndefined();
  });

  it("no desbloquea una cuenta bloqueada (desbloquear sigue siendo del ADMIN)", async () => {
    const user = await createUserWithEmail("lock@empresa.com", { role: "COLLECTOR" });
    await pool.query(`UPDATE users SET locked_at = NOW(), failed_attempts = 3 WHERE id = $1`, [user.id]);
    await forgot("lock@empresa.com");
    expect((await reset(lastToken(), "nuevaClave1")).status).toBe(200);
    const u = await pool.query(`SELECT locked_at, failed_attempts FROM users WHERE id = $1`, [user.id]);
    expect(u.rows[0].locked_at).not.toBeNull();
    expect(u.rows[0].failed_attempts).toBe(0);
  });
});
