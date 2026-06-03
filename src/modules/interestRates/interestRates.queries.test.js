jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const pool = require("../../config/db");
const cache = require("../../utils/cache");
const queries = require("./interestRates.queries");

const ROW = {
  id: "r1",
  payment_frequency: "MONTHLY",
  installments_count: 12,
  min_amount: 1000,
  max_amount: 5000,
  rate: 0.05,
  active: true,
};

describe("interestRates.queries — caché", () => {
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

    it("cachea por filtros — filtros distintos hacen queries distintas", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findAll();
      await queries.findAll({ payment_frequency: "MONTHLY" });

      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("mismo filtro en dos llamados solo hace una query", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findAll({ active: true });
      await queries.findAll({ active: true });

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("findActiveInstallmentOptions", () => {
    it("consulta la BD en el primer llamado y agrupa por frecuencia", async () => {
      pool.query.mockResolvedValue({
        rows: [
          { payment_frequency: "MONTHLY", installments_count: 12 },
          { payment_frequency: "MONTHLY", installments_count: 24 },
          { payment_frequency: "WEEKLY", installments_count: 4 },
        ],
      });

      const result = await queries.findActiveInstallmentOptions();

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(result.MONTHLY).toEqual([12, 24]);
      expect(result.WEEKLY).toEqual([4]);
    });

    it("devuelve el resultado cacheado sin nueva query en el segundo llamado", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.findActiveInstallmentOptions();
      await queries.findActiveInstallmentOptions();

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidación al mutar", () => {
    it("create invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [{ ...ROW, id: "r2" }] }) // INSERT RETURNING
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.create({
        payment_frequency: "WEEKLY",
        installments_count: 4,
        min_amount: 500,
        max_amount: 2000,
        rate: 0.04,
      });
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("update invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [{ ...ROW, rate: 0.06 }] }) // UPDATE RETURNING
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.update("r1", { rate: 0.06 });
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("reactivate invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [{ ...ROW, active: true }] }) // UPDATE RETURNING
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.reactivate("r1", 0.05);
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("deactivate invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [] }) // deactivate UPDATE
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.deactivate("r1");
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("activate invalida el caché de findAll", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [ROW] }) // findAll MISS
        .mockResolvedValueOnce({ rows: [] }) // activate UPDATE
        .mockResolvedValueOnce({ rows: [ROW] }); // findAll tras invalidación

      await queries.findAll();
      await queries.activate("r1");
      await queries.findAll();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("cualquier mutación invalida también findActiveInstallmentOptions", async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ payment_frequency: "MONTHLY", installments_count: 12 }],
        }) // findActiveInstallmentOptions MISS
        .mockResolvedValueOnce({ rows: [] }) // deactivate UPDATE
        .mockResolvedValueOnce({
          rows: [{ payment_frequency: "MONTHLY", installments_count: 12 }],
        }); // findActiveInstallmentOptions tras invalidación

      await queries.findActiveInstallmentOptions();
      await queries.deactivate("r1");
      await queries.findActiveInstallmentOptions();

      expect(pool.query).toHaveBeenCalledTimes(3);
    });
  });
});
