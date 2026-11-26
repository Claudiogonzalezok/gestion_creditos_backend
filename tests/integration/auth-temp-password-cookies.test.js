// Integración — contraseña temporal y cookies de refresh separadas.
//   #97  · Portal: con portal_is_temp_password el login avisa el cambio
//          obligatorio y las rutas del portal (salvo el cambio) responden 403
//          TEMP_PASSWORD_REQUIRED hasta cambiarla.
//   #101 · Interno usa cookie `rt` y portal `prt`: no se pisan; un refresh con
//          token del tipo equivocado responde 401 sin revocarlo; el logout de
//          una sesión no afecta a la otra.
//   #105 · El 403 interno por contraseña temporal incluye code TEMP_PASSWORD_REQUIRED.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture, createCustomerFixture } = require("./helpers/fixtures");

setupTestSuite();

const PASSWORD = "Secreta123";
const NEW_PASSWORD = "NuevaClave456";
let passwordHash;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

/**
 * Crea un cliente con acceso al portal y contraseña conocida.
 * @param {boolean} temp - si la contraseña es temporal
 * @returns {Promise<object>} cliente
 */
const portalCustomer = async (temp) => {
  const c = await createCustomerFixture();
  await pool.query(
    `UPDATE customers SET portal_enabled = TRUE, portal_password_hash = $1,
            portal_is_temp_password = $2 WHERE id = $3`,
    [passwordHash, temp, c.id],
  );
  return c;
};

/**
 * Extrae la cookie indicada del header Set-Cookie.
 * @returns {{value: string, raw: string}|null}
 */
const getCookie = (res, name) => {
  const raw = (res.headers["set-cookie"] || []).find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  return { value: raw.split(";")[0].slice(name.length + 1), raw };
};

const loginInternal = (dni) => request(app).post("/api/auth/login").send({ dni, password: PASSWORD });
const loginPortal = (dni, password = PASSWORD) =>
  request(app).post("/api/auth/portal/login").send({ dni, password });

describe("#105 · 403 interno por contraseña temporal", () => {
  it("responde 403 con code TEMP_PASSWORD_REQUIRED y conserva el mensaje", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash, is_temp_password: true });
    const login = await loginInternal(u.dni);
    expect(login.status).toBe(200);
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      code: "TEMP_PASSWORD_REQUIRED",
      message: "Debés cambiar tu contraseña antes de continuar.",
    });
  });
});

describe("#97 · portal con contraseña temporal", () => {
  it("login indica cambio obligatorio y bloquea rutas del portal hasta cambiarla", async () => {
    const c = await portalCustomer(true);
    const login = await loginPortal(c.dni);
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ must_change_password: true, code: "TEMP_PASSWORD_REQUIRED" });
    const token = login.body.data.token;

    const blocked = await request(app).get("/api/portal/credits").set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("TEMP_PASSWORD_REQUIRED");
    expect((await request(app).get("/api/portal/me").set("Authorization", `Bearer ${token}`)).status).toBe(403);

    const change = await request(app)
      .post("/api/auth/portal/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD, confirm_password: NEW_PASSWORD });
    expect(change.status).toBe(200);

    const ok = await request(app).get("/api/portal/credits").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    const relogin = await loginPortal(c.dni, NEW_PASSWORD);
    expect(relogin.body.data.must_change_password).toBe(false);
    expect(relogin.body.data.code).toBeUndefined();
  });

  it("No romper: cliente sin contraseña temporal accede normalmente", async () => {
    const c = await portalCustomer(false);
    const login = await loginPortal(c.dni);
    expect(login.body.data.must_change_password).toBe(false);
    const res = await request(app).get("/api/portal/credits").set("Authorization", `Bearer ${login.body.data.token}`);
    expect(res.status).toBe(200);
  });
});

describe("#101 · cookies de refresh interno y portal separadas", () => {
  it("usa rt (path /api/auth) para interno y prt (path /api/auth/portal) para portal", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash });
    const c = await portalCustomer(false);
    const rt = getCookie(await loginInternal(u.dni), "rt");
    const prt = getCookie(await loginPortal(c.dni), "prt");
    expect(rt.raw).toMatch(/Path=\/api\/auth(;|$)/);
    expect(prt.raw).toMatch(/Path=\/api\/auth\/portal(;|$)/);
  });

  it("login interno + portal en el mismo navegador: ambos refresh funcionan", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash });
    const c = await portalCustomer(false);
    const rt = getCookie(await loginInternal(u.dni), "rt").value;
    const prt = getCookie(await loginPortal(c.dni), "prt").value;
    const jar = `rt=${rt}; prt=${prt}`;

    const ri = await request(app).post("/api/auth/refresh").set("Cookie", jar);
    expect(ri.status).toBe(200);
    expect(getCookie(ri, "rt")).not.toBeNull();
    expect(getCookie(ri, "prt")).toBeNull();

    const rp = await request(app).post("/api/auth/portal/refresh").set("Cookie", jar);
    expect(rp.status).toBe(200);
    expect(getCookie(rp, "prt")).not.toBeNull();
    expect(getCookie(rp, "rt")).toBeNull();
  });

  it("refresh con token del tipo equivocado → 401 sin revocarlo ni borrar cookies", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash });
    const c = await portalCustomer(false);
    const rt = getCookie(await loginInternal(u.dni), "rt").value;
    const prt = getCookie(await loginPortal(c.dni), "prt").value;

    const wrongPortal = await request(app).post("/api/auth/portal/refresh").set("Cookie", `prt=${rt}`);
    expect(wrongPortal.status).toBe(401);
    expect(wrongPortal.body.code).toBe("INVALID_TOKEN_TYPE");
    expect(wrongPortal.headers["set-cookie"]).toBeUndefined();

    const wrongInternal = await request(app).post("/api/auth/refresh").set("Cookie", `rt=${prt}`);
    expect(wrongInternal.status).toBe(401);
    expect(wrongInternal.body.code).toBe("INVALID_TOKEN_TYPE");
    expect(wrongInternal.headers["set-cookie"]).toBeUndefined();

    // Ninguno de los dos quedó revocado.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", `rt=${rt}`)).status).toBe(200);
    expect((await request(app).post("/api/auth/portal/refresh").set("Cookie", `prt=${prt}`)).status).toBe(200);
  });

  it("logout del portal → la sesión interna sigue refrescando (y viceversa)", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash });
    const c = await portalCustomer(false);
    const li = await loginInternal(u.dni);
    const lp = await loginPortal(c.dni);
    const rt = getCookie(li, "rt").value;
    const prt = getCookie(lp, "prt").value;
    const jar = `rt=${rt}; prt=${prt}`;

    const out = await request(app)
      .post("/api/auth/portal/logout")
      .set("Authorization", `Bearer ${lp.body.data.token}`)
      .set("Cookie", jar);
    expect(out.status).toBe(200);
    expect(getCookie(out, "prt").raw).toMatch(/Path=\/api\/auth\/portal/);
    expect(getCookie(out, "rt")).toBeNull();

    expect((await request(app).post("/api/auth/refresh").set("Cookie", jar)).status).toBe(200);
    expect((await request(app).post("/api/auth/portal/refresh").set("Cookie", jar)).status).toBe(401);
  });

  it("logout interno no revoca la sesión del portal", async () => {
    const u = await createUserFixture({ role: "SELLER", password_hash: passwordHash });
    const c = await portalCustomer(false);
    const li = await loginInternal(u.dni);
    const prt = getCookie(await loginPortal(c.dni), "prt").value;
    const jar = `rt=${getCookie(li, "rt").value}; prt=${prt}`;

    const out = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${li.body.data.token}`)
      .set("Cookie", jar);
    expect(out.status).toBe(200);
    expect(getCookie(out, "prt")).toBeNull();
    expect((await request(app).post("/api/auth/portal/refresh").set("Cookie", jar)).status).toBe(200);
  });

  it('logout del portal revoca y limpia la cookie legacy rt de una sesión de portal previa', async () => {
    const c = await portalCustomer(false);
    const lp = await loginPortal(c.dni);
    const legacyJar = 'rt=' + getCookie(lp, 'prt').value;

    const out = await request(app)
      .post('/api/auth/portal/logout')
      .set('Authorization', 'Bearer ' + lp.body.data.token)
      .set('Cookie', legacyJar);
    expect(out.status).toBe(200);
    expect(getCookie(out, 'rt').raw).toMatch(/Path=\/api\/auth;/);
    expect((await request(app).post('/api/auth/portal/refresh').set('Cookie', legacyJar)).status).toBe(401);
  });
});
