jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const pool = require("../../config/db");
const cache = require("../../utils/cache");
const queries = require("./productRates.queries");

const ROW = {
  id: "r1",
  product_id: "p1",
  product_name: "Producto A",
  payment_frequency: "MONTHLY",
  installments_count: 12,
  rate: 0.05,
  active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

describe("productRates.queries — caché", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.clearAll();
  });

  describe("findAll", () => {
    it("consulta la BD en el primer llamado y devuelve las filas", async () => {
      pool.query.mockResolvedValue({ rows: [ROW] });

      const result = await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it("devuelve el resultado cacheado sin nueva query en el segundo llamado", async () => {
      pool.query.mockResolvedValue({ rows: [ROW] });

      await queries.findAll();
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("cachea por productId — productId distintos hacen queries distintas", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findAll();
      await queries.findAll("p1");

      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("mismo productId en dos llamados solo hace una query", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findAll("p1");
      await queries.findAll("p1");

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("findActiveInstallmentOptionsForProduct", () => {
    it("consulta la BD en el primer llamado y agrupa por frecuencia", async () => {
      pool.query.mockResolvedValue({
        rows: [
          { payment_frequency: "MONTHLY", installments_count: 12 },
          { payment_frequency: "MONTHLY", installments_count: 24 },
        ],
      });

      const result = await queries.findActiveInstallmentOptionsForProduct("p1");

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(result.MONTHLY).toEqual([12, 24]);
    });

    it("devuelve el resultado cacheado sin nueva query en el segundo llamado", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findActiveInstallmentOptionsForProduct("p1");
      await queries.findActiveInstallmentOptionsForProduct("p1");

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("cachea por productId — productos distintos hacen queries distintas", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findActiveInstallmentOptionsForProduct("p1");
      await queries.findActiveInstallmentOptionsForProduct("p2");

      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidación al mutar", () => {
    it("create (nuevo INSERT) invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [] }) // findExact → no existe
        .mockResolvedValueOnce({ rows: [{ id: "r2" }] }) // INSERT RETURNING id
        .mockResolvedValueOnce({ rows: [ROW] }) // findById dentro de create
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.create({
        product_id: "p1",
        payment_frequency: "WEEKLY",
        installments_count: 4,
        rate: 0.04,
      });
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(5);
    });

    it("create (reactivación) invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [{ id: "r1", active: false }] }) // findExact → existe inactiva
        .mockResolvedValueOnce({ rows: [{ id: "r1" }] }) // UPDATE (reactivar) RETURNING id
        .mockResolvedValueOnce({ rows: [ROW] }) // findById dentro de create
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.create({
        product_id: "p1",
        payment_frequency: "MONTHLY",
        installments_count: 12,
        rate: 0.05,
      });
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(5);
    });

    it("update invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [] }) // UPDATE (sin RETURNING)
        .mockResolvedValueOnce({ rows: [ROW] }) // findById dentro de update
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.update("r1", { rate: 0.06 });
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(4);
    });

    it("update invalida también findActiveInstallmentOptionsForProduct", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ payment_frequency: "MONTHLY", installments_count: 12 }],
        }) // options MISS
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [ROW] }) // findById dentro de update
        .mockResolvedValueOnce({
          rows: [{ payment_frequency: "MONTHLY", installments_count: 12 }],
        }); // options tras invalidación

      await queries.findActiveInstallmentOptionsForProduct("p1");
      await queries.update("r1", { active: false });
      await queries.findActiveInstallmentOptionsForProduct("p1");

      expect(pool.query).toHaveBeenCalledTimes(4);
    });

    it("update sin campos no hace query y no invalida el caché", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [ROW] }); // findById dentro de update (sin fields)

      await queries.findAll();
      await queries.update("r1", {});
      await queries.findAll(); // debe seguir cacheado

      // findAll (1) + findById en update (1) + findAll desde cache (0 queries) = 2 total
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });
});
