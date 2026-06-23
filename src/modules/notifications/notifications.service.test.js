// Tests unitarios de notifications.service — núcleo de emisión de notificaciones.
//
// Cubre:
//   · notify() no inserta nada si la preferencia del tipo está enabled=false.
//   · notify() inserta push por cada userId cuando enabled=true.
//   · notify() solo dispara email si el caller pidió el canal Y email_enabled=true.
//   · notify() nunca lanza si el mailer falla (best-effort).
//   · listByUser/countUnread devuelven el shape esperado (delegan a queries).

jest.mock("./notifications.queries", () => ({
  getPreferenceByType: jest.fn(),
  insertNotification: jest.fn(),
  listByUser: jest.fn(),
  countUnread: jest.fn(),
  markRead: jest.fn(),
  markAllRead: jest.fn(),
  getUserEmail: jest.fn(),
}));

jest.mock("../../utils/mailer", () => ({
  sendMail: jest.fn(),
}));

const queries = require("./notifications.queries");
const mailer = require("../../utils/mailer");
const service = require("./notifications.service");

describe("notifications.service.notify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("no inserta notificación si la preferencia del tipo está enabled=false", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: false,
      email_enabled: false,
      frequency: "INSTANT",
    });

    await service.notify({
      type: "MORA",
      title: "Mora detectada",
      message: "El cliente X entró en mora.",
      targetUserIds: ["user-1"],
      channels: ["push"],
    });

    expect(queries.insertNotification).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("trata un tipo sin fila de preferencia como enabled=true (default)", async () => {
    queries.getPreferenceByType.mockResolvedValue(null);
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });

    await service.notify({
      type: "MORA",
      title: "Mora detectada",
      message: "msg",
      targetUserIds: ["user-1"],
      channels: ["push"],
    });

    expect(queries.insertNotification).toHaveBeenCalledTimes(1);
  });

  it("inserta una notificación push por cada userId destino", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "NEW_CUSTOMER",
      enabled: true,
      email_enabled: false,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });

    await service.notify({
      type: "NEW_CUSTOMER",
      title: "Nuevo cliente",
      message: "msg",
      targetUserIds: ["user-1", "user-2"],
      channels: ["push"],
    });

    expect(queries.insertNotification).toHaveBeenCalledTimes(2);
  });

  it("no dispara email si el caller no pidió el canal aunque email_enabled sea true", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: true,
      email_enabled: true,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });

    await service.notify({
      type: "MORA",
      title: "t",
      message: "m",
      targetUserIds: ["user-1"],
      channels: ["push"],
    });

    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("no dispara email si email_enabled es false aunque el caller pida el canal", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: true,
      email_enabled: false,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });
    queries.getUserEmail.mockResolvedValue("user@test.com");

    await service.notify({
      type: "MORA",
      title: "t",
      message: "m",
      targetUserIds: ["user-1"],
      channels: ["push", "email"],
    });

    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("dispara email solo si el usuario destino tiene email registrado", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: true,
      email_enabled: true,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });
    queries.getUserEmail.mockResolvedValueOnce(null); // user-1 sin email
    queries.getUserEmail.mockResolvedValueOnce("user2@test.com"); // user-2 con email

    await service.notify({
      type: "MORA",
      title: "t",
      message: "m",
      targetUserIds: ["user-1", "user-2"],
      channels: ["push", "email"],
    });

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user2@test.com" }),
    );
  });

  it("un fallo del mailer no propaga el error (best-effort)", async () => {
    queries.getPreferenceByType.mockResolvedValue({
      type: "MORA",
      enabled: true,
      email_enabled: true,
      frequency: "INSTANT",
    });
    queries.insertNotification.mockResolvedValue({ id: "notif-1" });
    queries.getUserEmail.mockResolvedValue("user@test.com");
    mailer.sendMail.mockRejectedValue(new Error("SMTP caído"));

    await expect(
      service.notify({
        type: "MORA",
        title: "t",
        message: "m",
        targetUserIds: ["user-1"],
        channels: ["push", "email"],
      }),
    ).resolves.not.toThrow();
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
});
