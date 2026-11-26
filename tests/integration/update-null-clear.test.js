// Integración — PUT /customers/:id, PUT /users/:id y PATCH /users/me con null / '' (issue #65).
//
// Regla:
//   · `assigned_collector_id: null` (o '') desasigna el cobrador del cliente.
//   · '' o null en un campo de texto opcional lo deja en NULL (no en cadena vacía).
//   · Un campo omitido del body no cambia su valor.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock("uuid", () => ({ v4: () => require("crypto").randomUUID() }));

const request = require("supertest");
const app = require("../../src/app");
const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture, createCustomerFixture } = require("./helpers/fixtures");
const { generateInternalToken } = require("../../src/utils/jwt");

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

const reloadCustomer = async (id) =>
  (await pool.query(
    "SELECT full_name, address, phone, email, assigned_collector_id FROM customers WHERE id = $1",
    [id],
  )).rows[0];

const reloadUser = async (id) =>
  (await pool.query("SELECT full_name, email, phone, address FROM users WHERE id = $1", [id])).rows[0];

/** Cliente con cobrador asignado y todos los campos opcionales completos. */
const seedAssignedCustomer = async () => {
  const collector = await createUserFixture({ role: "COLLECTOR" });
  const customer = await createCustomerFixture({ email: "cli@test.com" });
  await pool.query("UPDATE customers SET assigned_collector_id = $1 WHERE id = $2", [
    collector.id,
    customer.id,
  ]);
  return { collector, customer };
};

describe("PUT /customers/:id — null / '' / omitido (#65)", () => {
  let admin;
  beforeEach(async () => {
    admin = await createUserFixture({ role: "ADMIN" });
  });

  it("assigned_collector_id: null desasigna el cobrador", async () => {
    const { customer } = await seedAssignedCustomer();
    const res = await request(app)
      .put(`/api/customers/${customer.id}`)
      .set(auth(admin))
      .send({ assigned_collector_id: null });

    expect(res.status).toBe(200);
    expect(res.body.data.assigned_collector_id).toBeNull();
    expect((await reloadCustomer(customer.id)).assigned_collector_id).toBeNull();
  });

  it("assigned_collector_id: '' desasigna (no 500)", async () => {
    const { customer } = await seedAssignedCustomer();
    const res = await request(app)
      .put(`/api/customers/${customer.id}`)
      .set(auth(admin))
      .send({ assigned_collector_id: "" });

    expect(res.status).toBe(200);
    expect((await reloadCustomer(customer.id)).assigned_collector_id).toBeNull();
  });

  it("'' y null en campos de texto opcionales los dejan en NULL", async () => {
    const { customer } = await seedAssignedCustomer();
    const res = await request(app)
      .put(`/api/customers/${customer.id}`)
      .set(auth(admin))
      .send({ address: "", phone: null, email: "" });

    expect(res.status).toBe(200);
    const row = await reloadCustomer(customer.id);
    expect(row.address).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
  });

  it("campos omitidos no cambian (incluido el cobrador)", async () => {
    const { collector, customer } = await seedAssignedCustomer();
    const res = await request(app)
      .put(`/api/customers/${customer.id}`)
      .set(auth(admin))
      .send({ full_name: "Nombre Nuevo" });

    expect(res.status).toBe(200);
    expect(await reloadCustomer(customer.id)).toEqual({
      full_name: "Nombre Nuevo",
      address: "Calle Test 123",
      phone: "1100000000",
      email: "cli@test.com",
      assigned_collector_id: collector.id,
    });
  });

  it("reasignar a otro cobrador sigue funcionando", async () => {
    const { customer } = await seedAssignedCustomer();
    const other = await createUserFixture({ role: "COLLECTOR" });
    const res = await request(app)
      .put(`/api/customers/${customer.id}`)
      .set(auth(admin))
      .send({ assigned_collector_id: other.id });

    expect(res.status).toBe(200);
    expect((await reloadCustomer(customer.id)).assigned_collector_id).toBe(other.id);
  });
});

describe("PUT /users/:id y PATCH /users/me — '' limpia, omitido no cambia (#65)", () => {
  let admin;
  beforeEach(async () => {
    admin = await createUserFixture({ role: "ADMIN" });
    await pool.query(
      "UPDATE users SET email = 'adm@test.com', address = 'Dir 1', phone = '111' WHERE id = $1",
      [admin.id],
    );
  });

  it("PUT /users/:id con address '' lo deja en NULL y no toca email", async () => {
    const res = await request(app)
      .put(`/api/users/${admin.id}`)
      .set(auth(admin))
      .send({ address: "" });

    expect(res.status).toBe(200);
    const row = await reloadUser(admin.id);
    expect(row.address).toBeNull();
    expect(row.email).toBe("adm@test.com");
  });

  it("PATCH /users/me con phone '' y email null los deja en NULL, address intacta", async () => {
    const res = await request(app)
      .patch("/api/users/me")
      .set(auth(admin))
      .send({ phone: "", email: null });

    expect(res.status).toBe(200);
    const row = await reloadUser(admin.id);
    expect(row.phone).toBeNull();
    expect(row.email).toBeNull();
    expect(row.address).toBe("Dir 1");
  });
});
