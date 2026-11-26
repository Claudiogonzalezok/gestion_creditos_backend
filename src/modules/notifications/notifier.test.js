const notifier = require("./notifier");

const KEYS = ["NODE_ENV", "NOTIFIER_TRANSPORT"];
const saved = {};
beforeEach(() => {
  KEYS.forEach((k) => (saved[k] = process.env[k]));
  notifier.clearOutbox();
  notifier.setTransport(null);
});
afterEach(() => {
  KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  notifier.setTransport(null);
});

const msg = { to: "a@b.com", subject: "s", text: "t" };

describe("notifier", () => {
  it("fuera de producción usa el transporte log y guarda el mensaje en el outbox", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.NOTIFIER_TRANSPORT;
    expect(notifier.isConfigured()).toBe(true);
    await expect(notifier.send(msg)).resolves.toEqual({ transport: "log" });
    expect(notifier.outbox).toHaveLength(1);
    expect(notifier.outbox[0]).toMatchObject(msg);
  });

  it("en producción falla cerrado aunque se pida log (no escribe tokens en logs)", async () => {
    process.env.NODE_ENV = "production";
    process.env.NOTIFIER_TRANSPORT = "log";
    expect(notifier.isConfigured()).toBe(false);
    await expect(notifier.send(msg)).rejects.toMatchObject({ status: 503, code: "NOTIFIER_NOT_CONFIGURED" });
    expect(notifier.outbox).toHaveLength(0);
  });

  it("NOTIFIER_TRANSPORT=disabled falla cerrado también en desarrollo", async () => {
    process.env.NODE_ENV = "development";
    process.env.NOTIFIER_TRANSPORT = "disabled";
    await expect(notifier.send(msg)).rejects.toMatchObject({ status: 503 });
  });

  it("un transporte registrado se usa incluso en producción", async () => {
    process.env.NODE_ENV = "production";
    const send = jest.fn().mockResolvedValue();
    notifier.setTransport({ send });
    expect(notifier.isConfigured()).toBe(true);
    await expect(notifier.send(msg)).resolves.toEqual({ transport: "custom" });
    expect(send).toHaveBeenCalledWith(msg);
  });
});
