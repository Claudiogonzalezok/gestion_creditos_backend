jest.mock("../config/db", () => ({ query: jest.fn() }));

const { parsePagination, runListQuery, sendList, MAX_LIMIT, DEFAULT_LIMIT } = require("./pagination");

describe("parsePagination", () => {
  it("sin limit/offset/page devuelve null (comportamiento de siempre)", () => {
    expect(parsePagination({})).toBeNull();
    expect(parsePagination({ status: "PENDING", limit: "" })).toBeNull();
  });

  it("limit + page calcula el offset", () => {
    expect(parsePagination({ limit: "10", page: "3" })).toEqual({ limit: 10, offset: 20 });
  });

  it("offset explícito gana sobre page", () => {
    expect(parsePagination({ limit: "10", page: "3", offset: "5" })).toEqual({ limit: 10, offset: 5 });
  });

  it("solo page usa el limit por defecto; limit se acota al máximo", () => {
    expect(parsePagination({ page: "2" })).toEqual({ limit: DEFAULT_LIMIT, offset: DEFAULT_LIMIT });
    expect(parsePagination({ limit: "999999" }).limit).toBe(MAX_LIMIT);
    expect(parsePagination({ limit: "-4" }).limit).toBe(1);
  });
});

describe("runListQuery", () => {
  it("sin paginación ejecuta el SQL tal cual y devuelve las filas", async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    await expect(runListQuery("SELECT 1", [], null, db)).resolves.toEqual([{ id: 1 }]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith("SELECT 1", []);
  });

  it("con paginación agrega LIMIT/OFFSET posicionales y cuenta el total", async () => {
    const db = {
      query: jest.fn(async (sql) =>
        sql.startsWith("SELECT COUNT") ? { rows: [{ total: 7 }] } : { rows: [{ id: 2 }] }),
    };
    const out = await runListQuery("SELECT * FROM t WHERE a = $1 ORDER BY id", ["x"], { limit: 2, offset: 4 }, db);
    expect(out).toEqual({ items: [{ id: 2 }], total: 7, limit: 2, offset: 4 });
    expect(db.query).toHaveBeenCalledWith(
      "SELECT * FROM t WHERE a = $1 ORDER BY id LIMIT $2 OFFSET $3", ["x", 2, 4]);
  });
});

describe("sendList", () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  it("array → respuesta estándar sin pagination", () => {
    const res = mockRes();
    sendList(res, [1, 2]);
    expect(res.json).toHaveBeenCalledWith({ ok: true, message: "OK", data: [1, 2] });
  });

  it("página → data con los items y pagination con el total", () => {
    const res = mockRes();
    sendList(res, { items: [1], total: 9, limit: 1, offset: 0 });
    expect(res.json).toHaveBeenCalledWith({
      ok: true, message: "OK", data: [1], pagination: { total: 9, limit: 1, offset: 0 },
    });
  });
});
