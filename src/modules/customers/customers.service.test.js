jest.mock("./customers.queries", () => ({
  findById: jest.fn(),
  findByDni: jest.fn(),
  findCollectorById: jest.fn(),
  update: jest.fn(),
}));

jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn(),
}));

jest.mock("../notifications/notifications.service", () => ({
  notify: jest.fn(),
}));

jest.mock("../notifications/notifications.queries", () => ({
  getActiveAdminUserIds: jest.fn(),
}));

const queries = require("./customers.queries");
const service = require("./customers.service");

describe("customers.service update — edición de DNI", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const existing = { id: "c1", dni: "11111111", collector_id: null };

  it("rechaza (409) si el DNI nuevo ya pertenece a otro cliente", async () => {
    queries.findById.mockResolvedValue(existing);
    queries.findByDni.mockResolvedValue({ id: "c2" });

    await expect(
      service.update("c1", { dni: "22222222" }),
    ).rejects.toMatchObject({ status: 409 });

    expect(queries.update).not.toHaveBeenCalled();
  });

  it("permite cambiar el DNI cuando es único", async () => {
    queries.findById.mockResolvedValue(existing);
    queries.findByDni.mockResolvedValue(null);
    queries.update.mockResolvedValue({ id: "c1", dni: "22222222" });

    await service.update("c1", { dni: "22222222" });

    expect(queries.findByDni).toHaveBeenCalledWith("22222222");
    expect(queries.update).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ dni: "22222222" }),
    );
  });

  it("no valida unicidad si el DNI no cambió", async () => {
    queries.findById.mockResolvedValue(existing);
    queries.update.mockResolvedValue({ id: "c1", dni: "11111111" });

    await service.update("c1", { dni: "11111111", full_name: "Nuevo Nombre" });

    expect(queries.findByDni).not.toHaveBeenCalled();
    expect(queries.update).toHaveBeenCalled();
  });

  it("rechaza (404) si el cliente no existe", async () => {
    queries.findById.mockResolvedValue(null);

    await expect(
      service.update("missing", { dni: "22222222" }),
    ).rejects.toMatchObject({ status: 404 });

    expect(queries.update).not.toHaveBeenCalled();
  });
});
