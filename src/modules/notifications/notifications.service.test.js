// Tests unitarios de notifications.service — núcleo de emisión de notificaciones.
//
// Cubre:
//   · notify() no inserta nada si la preferencia del tipo está enabled=false.
//   · notify() inserta push por cada userId cuando enabled=true.
//   · listByUser/countUnread devuelven el shape esperado (delegan a queries).

jest.mock("./notifications.queries", () => ({
  getPreferenceByType: jest.fn(),
  updatePreferenceWithClient: jest.fn(),
  insertNotification: jest.fn(),
  listByUser: jest.fn(),
  countUnread: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
  deleteById: jest.fn(),
  deleteAllByUser: jest.fn(),
}));

jest.mock("../../utils/transaction", () => ({
  withTransaction: jest.fn((callback) => callback({ query: jest.fn() })),
}));

const queries = require("./notifications.queries");
const { withTransaction } = require("../../utils/transaction");
const service = require("./notifications.service");

describe("notifications.service.notify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("no inserta notificación si la preferencia del tipo está enabled=false", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: false,
      frequency: "INSTANT",
    });

    await service.notify({
      type: "MORA",
      title: "Mora detectada",
      message: "El cliente X entró en mora.",
      targetUserIds: ["user-1"],
    });

    expect(queries.insertNotification).not.toHaveBeenCalled();
  });

  it("trata un tipo sin fila de preferencia como enabled=true (default)", async () => {
    queries.getPreferenceByType.mockResolvedValue(null);
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });

    await service.notify({
      type: "MORA",
      title: "Mora detectada",
      message: "msg",
      targetUserIds: ["user-1"],
    });

    expect(queries.insertNotification).toHaveBeenCalledTimes(1);
  });

  it("inserta una notificación push por cada userId destino", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "NEW_CUSTOMER",
      enabled: true,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });

    await service.notify({
      type: "NEW_CUSTOMER",
      title: "Nuevo cliente",
      message: "msg",
      targetUserIds: ["user-1", "user-2"],
    });

    expect(queries.insertNotification).toHaveBeenCalledTimes(2);
  });

  it("no hace nada si targetUserIds está vacío", async () => {
    await service.notify({
      type: "MORA",
      title: "t",
      message: "m",
      targetUserIds: [],
    });

    expect(queries.getPreferenceByType).not.toHaveBeenCalled();
  });
});

describe("notifications.service — historial y unread-count", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("listByUser delega en queries.listByUser y devuelve su shape", async () => {
    const fakeResult = { items: [{ id: "n1" }], total: 1, page: 1, limit: 20 };
    queries.listByUser.mockResolvedValue(fakeResult);

    const result = await service.listByUser("user-1", 1, 20);

    expect(queries.listByUser).toHaveBeenCalledWith("user-1", 1, 20);
    expect(result).toEqual(fakeResult);
  });

  it("countUnread delega en queries.countUnread y devuelve el número", async () => {
    queries.countUnread.mockResolvedValue(3);

    const result = await service.countUnread("user-1");

    expect(result).toBe(3);
  });

  it("deleteById delega en queries.deleteById con usuario dueño", async () => {
    queries.deleteById.mockResolvedValue(true);

    await service.deleteById("notif-1", "user-1");

    expect(queries.deleteById).toHaveBeenCalledWith("notif-1", "user-1");
  });

  it("deleteAllByUser delega en queries.deleteAllByUser", async () => {
    queries.deleteAllByUser.mockResolvedValue(2);

    await service.deleteAllByUser("user-1");

    expect(queries.deleteAllByUser).toHaveBeenCalledWith("user-1");
  });
});

describe("notifications.service.updatePreferences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("actualiza preferencias en una única transacción", async () => {
    queries.updatePreferenceWithClient
      .mockResolvedValueOnce({ type: "MORA", enabled: false })
      .mockResolvedValueOnce({ type: "NEW_CUSTOMER", enabled: true });

    const result = await service.updatePreferences([
      { type: "MORA", enabled: false },
      { type: "NEW_CUSTOMER", enabled: true },
    ]);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(queries.updatePreferenceWithClient).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { type: "MORA", enabled: false },
      { type: "NEW_CUSTOMER", enabled: true },
    ]);
  });
});
