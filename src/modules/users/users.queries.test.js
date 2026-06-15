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
