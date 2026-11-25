// Contrato de errores de login/refresh (#35, #42): la respuesta 401 conserva
// { ok, message } y agrega code / retry_after_seconds cuando corresponde.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.mock("../../src/config/db", () => ({ query: jest.fn() }));
jest.mock("../../src/modules/auth/auth.service");

const service = require("../../src/modules/auth/auth.service");
const controller = require("../../src/modules/auth/auth.controller");

/** Respuesta express mínima que registra status, headers y body. */
const mockRes = () => {
  const res = { headers: {} };
  res.status = jest.fn((c) => ((res.statusCode = c), res));
  res.json = jest.fn((b) => ((res.body = b), res));
  res.set = jest.fn((k, v) => ((res.headers[k] = v), res));
  res.cookie = jest.fn(() => res);
  return res;
};

describe("auth.controller · errores 401", () => {
  it("credenciales incorrectas: forma original sin code (compatibilidad)", async () => {
    service.loginInternal.mockRejectedValue({ status: 401, message: "Credenciales incorrectas." });
    const res = mockRes();
    await controller.loginInternal({ body: { dni: "1", password: "x" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, message: "Credenciales incorrectas." });
    expect(res.set).not.toHaveBeenCalled();
  });

  it("bloqueo temporal de ADMIN: code, retry_after_seconds y header Retry-After", async () => {
    service.loginInternal.mockRejectedValue({
      status: 401,
      code: "ACCOUNT_TEMP_LOCKED",
      retry_after_seconds: 900,
      message: "Bloqueada temporalmente.",
    });
    const res = mockRes();
    await controller.loginInternal({ body: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      message: "Bloqueada temporalmente.",
      code: "ACCOUNT_TEMP_LOCKED",
      retry_after_seconds: 900,
    });
    expect(res.headers["Retry-After"]).toBe("900");
  });

  it("refresh perdido en carrera: code REFRESH_TOKEN_ROTATED", async () => {
    service.refreshInternalToken.mockRejectedValue({
      status: 401,
      code: "REFRESH_TOKEN_ROTATED",
      message: "La sesión ya fue renovada.",
    });
    const res = mockRes();
    await controller.refreshInternal({ cookies: { rt: "abc" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe("REFRESH_TOKEN_ROTATED");
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("portal: ACCOUNT_LOCKED y refresh de portal con SESSION_REVOKED", async () => {
    service.loginPortal.mockRejectedValue({ status: 401, code: "ACCOUNT_LOCKED", message: "Bloqueada." });
    service.refreshPortalToken.mockRejectedValue({ status: 401, code: "SESSION_REVOKED", message: "Revocada." });
    const r1 = mockRes();
    const r2 = mockRes();
    await controller.loginPortal({ body: {} }, r1);
    await controller.refreshPortal({ cookies: {} }, r2);
    expect(r1.body).toEqual({ ok: false, message: "Bloqueada.", code: "ACCOUNT_LOCKED" });
    expect(r2.body).toEqual({ ok: false, message: "Revocada.", code: "SESSION_REVOKED" });
  });
});
