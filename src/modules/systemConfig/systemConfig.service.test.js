jest.mock("./systemConfig.queries", () => ({
  findAll: jest.fn(),
  findByKey: jest.fn(),
  getValue: jest.fn(),
  update: jest.fn(),
  resetToDefault: jest.fn(),
}));

const queries = require("./systemConfig.queries");
const service = require("./systemConfig.service");

describe("systemConfig.service.update — validación numérica estricta", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queries.findByKey.mockResolvedValue({ key: "x", value: "1" });
    queries.update.mockImplementation(async (key, value) => ({ key, value }));
  });

  it.each(["12abc", "abc", "1e3", "0x10", "", "   ", "NaN", "Infinity", "1.2.3", null, true, {}, [], NaN, Infinity])(
    "rechaza el valor no numérico %p con 400 sin persistir",
    async (value) => {
      await expect(service.update("login_max_attempts", value, "u1")).rejects.toEqual({
        status: 400,
        message: "El valor debe ser numérico.",
      });
      expect(queries.update).not.toHaveBeenCalled();
    },
  );

  it.each(["-1", -2, "-0.5"])(
    "rechaza el valor negativo %p con 400 aunque la clave no tenga rango definido",
    async (value) => {
      await expect(service.update("rt_expiry_internal_days", value, "u1")).rejects.toEqual({
        status: 400,
        message: "El valor no puede ser negativo.",
      });
      expect(queries.update).not.toHaveBeenCalled();
    },
  );

  it("rechaza valores fuera de rango con 400 (comportamiento previo)", async () => {
    await expect(service.update("login_max_attempts", "11", "u1")).rejects.toEqual({
      status: 400,
      message: "El valor debe estar entre 1 y 10.",
    });
    expect(queries.update).not.toHaveBeenCalled();
  });

  it.each([
    ["login_max_attempts", "5", "5"],
    ["login_max_attempts", " 7 ", "7"],
    ["login_max_attempts", 3, "3"],
    ["commission_rate", "0.08", "0.08"],
    ["rt_expiry_internal_days", "0", "0"],
  ])("acepta %s = %p y persiste %p", async (key, value, stored) => {
    const res = await service.update(key, value, "u1");
    expect(res).toEqual({ key, value: stored });
    expect(queries.update).toHaveBeenCalledWith(key, stored, "u1");
  });

  it("mantiene la validación cruzada min/max de montos", async () => {
    queries.getValue.mockResolvedValue("1000");
    await expect(service.update("min_credit_amount", "1000", "u1")).rejects.toEqual({
      status: 400,
      message: "El monto mínimo debe ser menor al monto máximo configurado.",
    });
  });

  it("devuelve 404 si la clave no existe", async () => {
    queries.findByKey.mockResolvedValue(null);
    await expect(service.update("nope", "1", "u1")).rejects.toEqual({ status: 404, message: "Parámetro no encontrado." });
  });
});
