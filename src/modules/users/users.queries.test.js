jest.mock("../../config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const pool = require("../../config/db");
const queries = require("./users.queries");

describe("users.queries.findAll — filtro por conjunto de roles", () => {
  beforeEach(() => jest.clearAllMocks());

  it("roles (array) genera role = ANY(...) — incluye SELLER_COLLECTOR", async () => {
    await queries.findAll({
      roles: ["COLLECTOR", "SELLER_COLLECTOR"],
      status: "ACTIVE",
    });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("role = ANY(");
    expect(params).toContainEqual(["COLLECTOR", "SELLER_COLLECTOR"]);
  });

  it("role exacto tiene prioridad sobre roles (compat)", async () => {
    await queries.findAll({ role: "COLLECTOR", roles: ["SELLER"] });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("role = $1");
    expect(sql).not.toContain("ANY(");
  });

  it("sin role ni roles: no filtra por rol", async () => {
    await queries.findAll({ status: "ACTIVE" });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain("role =");
  });
});

describe("users.queries — perfil propio", () => {
  beforeEach(() => jest.clearAllMocks());

  it("findOwnProfileById expone phone y datos personales seguros", async () => {
    await queries.findOwnProfileById("usr-1");
    const [sql, params] = pool.query.mock.calls[0];

    expect(sql).toContain("phone");
    expect(sql).toContain("last_login_at");
    expect(sql).not.toContain("password_hash");
    expect(params).toEqual(["usr-1"]);
  });

  it("updateOwnProfile actualiza solo campos editables del usuario", async () => {
    await queries.updateOwnProfile("usr-1", {
      full_name: "Usuario Test",
      email: "user@test.com",
      phone: "+54 11 5555-5555",
      address: "Av. Test 123",
    });
    const [sql, params] = pool.query.mock.calls[0];

    expect(sql).toContain("full_name");
    expect(sql).toContain("email");
    expect(sql).toContain("phone");
    expect(sql).toContain("address");
    expect(sql).not.toContain("role       =");
    expect(sql).not.toContain("dni        =");
    expect(params).toEqual([
      "Usuario Test",
      "user@test.com",
      "+54 11 5555-5555",
      "Av. Test 123",
      "usr-1",
    ]);
  });
});
