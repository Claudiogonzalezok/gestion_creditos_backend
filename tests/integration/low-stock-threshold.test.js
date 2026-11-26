// Integración — umbral de stock bajo configurable (issue #106).
//   · low_stock_threshold vive en system_config (default 5).
//   · GET/PUT /api/company lo exponen y actualizan.
//   · GET /api/reports/products lo usa si no llega stock_threshold.

jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

let seq = 0;
/**
 * Crea un producto con N unidades disponibles.
 * @param {number} units
 * @returns {Promise<string>} id del producto
 */
const createProductWithUnits = async (units) => {
  seq += 1;
  const tag = `LST-${seq}-${Date.now()}`;
  const p = await pool.query(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [tag]);
  const v = await pool.query(
    `INSERT INTO product_variants (product_id, current_price) VALUES ($1, 100) RETURNING id`,
    [p.rows[0].id],
  );
  for (let i = 0; i < units; i++) {
    await pool.query(`INSERT INTO product_units (variant_id, unit_code) VALUES ($1, $2)`, [
      v.rows[0].id,
      `${tag}-${i}`,
    ]);
  }
  return p.rows[0].id;
};

afterEach(async () => {
  const admin = await createUserFixture({ role: "ADMIN" });
  await request(app).put("/api/company").set(auth(admin)).send({ low_stock_threshold: 5 });
});

describe("low_stock_threshold", () => {
  it("default 5 en GET /api/company", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const res = await request(app).get("/api/company").set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.low_stock_threshold).toBe(5);
  });

  it("configurado en 3: GET devuelve 3 y el reporte marca stock bajo con <= 3", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const put = await request(app).put("/api/company").set(auth(admin)).send({ low_stock_threshold: 3 });
    expect(put.status).toBe(200);
    expect(put.body.data.low_stock_threshold).toBe(3);

    const get = await request(app).get("/api/company").set(auth(admin));
    expect(get.body.data.low_stock_threshold).toBe(3);

    const three = await createProductWithUnits(3);
    const four = await createProductWithUnits(4);
    const rep = await request(app).get("/api/reports/products").set(auth(admin));
    expect(rep.status).toBe(200);
    const byId = Object.fromEntries(rep.body.data.map((p) => [p.id, p.low_stock]));
    expect(byId[three]).toBe(true);
    expect(byId[four]).toBe(false);

    // El query explícito sigue ganando.
    const rep2 = await request(app).get("/api/reports/products?stock_threshold=4").set(auth(admin));
    expect(rep2.body.data.find((p) => p.id === four).low_stock).toBe(true);
  });

  it("valida entero >= 0", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    for (const v of [-1, 2.5, "abc"]) {
      const res = await request(app).put("/api/company").set(auth(admin)).send({ low_stock_threshold: v });
      expect(res.status).toBe(400);
    }
  });
});
