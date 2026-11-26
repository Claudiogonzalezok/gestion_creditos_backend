// P33 (#38) — Paginación opcional con tope en listados y cotas en
// parámetros de entrada (notificaciones, simulador público, altas masivas).
//
// Contrato verificado:
//   · Sin limit/offset/page → respuesta idéntica a la de siempre (array plano).
//   · Con limit → solo esa página en `data` + `pagination.total` con el total.
//   · limit fuera de rango (-1, 100000) → 400.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));
jest.setTimeout(30000);

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createPendingPaymentFixture,
} = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

let admin;
beforeEach(async () => {
  admin = await createUserFixture({ role: "ADMIN" });
});

const LISTS = [
  "/api/payments",
  "/api/installments",
  "/api/users",
  "/api/commissions",
  "/api/collection-attempts",
  "/api/cash-sessions",
];

describe("listados — paginación opcional", () => {
  beforeEach(async () => {
    await createPendingPaymentFixture();
    await createPendingPaymentFixture();
  });

  it.each(LISTS)("%s sin parámetros devuelve el array completo, sin pagination", async (url) => {
    const res = await request(app).get(url).set(auth(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeUndefined();
  });

  it.each(LISTS)("%s?limit=1 devuelve una página e informa el total", async (url) => {
    const full = await request(app).get(url).set(auth(admin));
    const res = await request(app).get(`${url}?limit=1`).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(Math.min(1, full.body.data.length));
    expect(res.body.pagination).toEqual({ total: full.body.data.length, limit: 1, offset: 0 });
  });

  it.each(LISTS)("%s rechaza limit=-1 y limit=100000 con 400", async (url) => {
    for (const limit of ["-1", "100000", "abc"]) {
      const res = await request(app).get(`${url}?limit=${limit}`).set(auth(admin));
      expect(res.status).toBe(400);
    }
    const neg = await request(app).get(`${url}?offset=-5`).set(auth(admin));
    expect(neg.status).toBe(400);
  });

  it("payments: offset/page recorren páginas disjuntas en orden estable", async () => {
    const full = (await request(app).get("/api/payments").set(auth(admin))).body.data;
    expect(full.length).toBeGreaterThanOrEqual(2);
    const p1 = await request(app).get("/api/payments?limit=1&page=1").set(auth(admin));
    const p2 = await request(app).get("/api/payments?limit=1&offset=1").set(auth(admin));
    expect(p1.body.data[0].id).toBe(full[0].id);
    expect(p2.body.data[0].id).toBe(full[1].id);
    expect(p2.body.pagination.offset).toBe(1);
  });
});

describe("users — más filas que el tope", () => {
  it("con limit=100 no devuelve todas las filas y el total las cuenta a todas", async () => {
    await pool.query(
      `INSERT INTO users (full_name, dni, password_hash, role, status, is_temp_password)
       SELECT 'Paginado ' || g, (800000000 + g)::text, '$2a$04$placeholder', 'COLLECTOR', 'ACTIVE', false
       FROM generate_series(1, 105) AS g`,
    );
    const full = await request(app).get("/api/users").set(auth(admin));
    expect(full.body.data.length).toBeGreaterThanOrEqual(106);

    const res = await request(app).get("/api/users?limit=100").set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.pagination.total).toBe(full.body.data.length);

    const last = await request(app).get("/api/users?limit=100&page=2").set(auth(admin));
    expect(last.body.data).toHaveLength(full.body.data.length - 100);
  });
});

describe("cotas de parámetros", () => {
  it("notificaciones: limit/page fuera de rango → 400; dentro del rango → 200", async () => {
    for (const qs of ["limit=-1", "limit=100000", "page=0", "page=-3"]) {
      const res = await request(app).get(`/api/notifications?${qs}`).set(auth(admin));
      expect(res.status).toBe(400);
    }
    const ok = await request(app).get("/api/notifications?page=1&limit=20").set(auth(admin));
    expect(ok.status).toBe(200);
    const def = await request(app).get("/api/notifications").set(auth(admin));
    expect(def.status).toBe(200);
  });

  it("simulador público de productos: limit fuera de rango → 400", async () => {
    for (const qs of ["limit=-1", "limit=100000"]) {
      const res = await request(app).get(`/api/credits/simulate/products?${qs}`);
      expect(res.status).toBe(400);
    }
    const ok = await request(app).get("/api/credits/simulate/products?limit=10");
    expect(ok.status).toBe(200);
    const def = await request(app).get("/api/credits/simulate/products");
    expect(def.status).toBe(200);
  });

  it("variantes: initial_units=1000000 → 400", async () => {
    const p = await pool.query(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [`P33 prod ${Date.now()}`]);
    const res = await request(app)
      .post("/api/product-variants")
      .set(auth(admin))
      .send({ product_id: p.rows[0].id, color: "Rojo", current_price: 100, initial_units: 1000000 });
    expect(res.status).toBe(400);
  });

  it("variantes bulk: la suma de initial_units no puede superar el tope total", async () => {
    const p = await pool.query(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [`P33 bulk ${Date.now()}`]);
    const rows = Array.from({ length: 3 }, (_, i) => ({
      color: `C${i}`, current_price: 100, initial_units: 5000,
    }));
    const res = await request(app)
      .post("/api/product-variants/bulk")
      .set(auth(admin))
      .send({ product_id: p.rows[0].id, rows });
    expect(res.status).toBe(400);
    const n = await pool.query(
      `SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1`,
      [p.rows[0].id],
    );
    expect(n.rows[0].n).toBe(0);
  });
});
