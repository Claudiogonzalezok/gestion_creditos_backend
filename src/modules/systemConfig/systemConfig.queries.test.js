jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const pool = require("../../config/db");
const cache = require("../../utils/cache");
const queries = require("./systemConfig.queries");

describe("systemConfig.queries — caché", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.clearAll();
  });

  describe("getValue", () => {
    it("consulta la BD en el primer llamado y devuelve el valor", async () => {
      pool.query.mockResolvedValue({ rows: [{ value: "0.08" }] });

      const result = await queries.getValue("commission_rate");

      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(result).toBe("0.08");
    });

    it("devuelve el valor cacheado sin consultar la BD en el segundo llamado", async () => {
      pool.query.mockResolvedValue({ rows: [{ value: "0.08" }] });

      await queries.getValue("commission_rate");
      await queries.getValue("commission_rate");

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("cachea por clave — claves distintas hacen queries distintas", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ value: "0.08" }] })
        .mockResolvedValueOnce({ rows: [{ value: "1000" }] });

      await queries.getValue("commission_rate");
      await queries.getValue("min_credit_amount");

      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it("devuelve el valor default cuando la BD no tiene la clave", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const result = await queries.getValue("commission_rate");

      expect(result).toBe("0.08");
    });

    it("cachea null cuando la clave no existe en BD ni en defaults", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.getValue("clave_inexistente");
      await queries.getValue("clave_inexistente");

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it("vuelve a consultar la BD después de que el TTL expira", async () => {
      jest.useFakeTimers();
      pool.query.mockResolvedValue({ rows: [{ value: "0.08" }] });

      await queries.getValue("commission_rate");
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      await queries.getValue("commission_rate");

      expect(pool.query).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });
  });

  describe("update — invalidación de caché", () => {
    it("invalida el caché de la clave actualizada", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ value: "0.08" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              key: "commission_rate",
              value: "0.10",
              description: "",
              updated_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ value: "0.10" }] });

      await queries.getValue("commission_rate");
      await queries.update("commission_rate", "0.10", "user-1");
      await queries.getValue("commission_rate");

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("no invalida claves distintas", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ value: "0.08" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              key: "penalty_grace_days",
              value: "5",
              description: "",
              updated_at: new Date(),
            },
          ],
        });

      await queries.getValue("commission_rate");
      await queries.update("penalty_grace_days", "5", "user-1");
      await queries.getValue("commission_rate");

      // commission_rate sigue cacheado — solo 2 queries (getValue + update)
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe("resetToDefault — invalidación de caché", () => {
    it("invalida el caché de la clave reseteada", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ value: "0.10" }] })
        .mockResolvedValueOnce({
          rows: [
            {
              key: "commission_rate",
              value: "0.08",
              description: "",
              updated_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ value: "0.08" }] });

      await queries.getValue("commission_rate");
      await queries.resetToDefault("commission_rate", "user-1");
      await queries.getValue("commission_rate");

      expect(pool.query).toHaveBeenCalledTimes(3);
    });

    it("devuelve null para una clave sin valor default", async () => {
      const result = await queries.resetToDefault(
        "clave_sin_default",
        "user-1",
      );
      expect(result).toBeNull();
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
