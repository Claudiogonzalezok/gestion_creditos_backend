// Test unitario del wrapper de envío de email (nodemailer + SMTP).
//
// Cubre el caso crítico de diseño: si faltan las variables de entorno SMTP,
// sendMail no debe lanzar — debe loguear un warning y resolver en no-op.
// Esto evita que el desarrollo local sin SMTP configurado rompa cualquier
// flujo de negocio que dispare notificaciones.

const mockNodemailer = {
  createTransport: jest.fn(),
};
jest.mock("nodemailer", () => mockNodemailer);

describe("mailer.sendMail", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_SECURE;
    mockNodemailer.createTransport.mockReset();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("no lanza y loguea warning cuando SMTP_HOST no está definido", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { sendMail } = require("./mailer");

    await expect(
      sendMail({
        to: "destino@test.com",
        subject: "Asunto",
        html: "<p>hola</p>",
      }),
    ).resolves.not.toThrow();

    expect(warnSpy).toHaveBeenCalled();
    expect(mockNodemailer.createTransport).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("envía el correo vía transporte SMTP cuando las vars están configuradas", async () => {
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user@test.com";
    process.env.SMTP_PASS = "secret";
    process.env.SMTP_FROM = "no-reply@test.com";
    process.env.SMTP_SECURE = "false";

    const sendMailFn = jest.fn().mockResolvedValue({ messageId: "abc" });
    mockNodemailer.createTransport.mockReturnValue({ sendMail: sendMailFn });

    const { sendMail } = require("./mailer");
    await sendMail({
      to: "destino@test.com",
      subject: "Asunto",
      html: "<p>hola</p>",
    });

    expect(mockNodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.test.com",
        port: 587,
        secure: false,
        auth: { user: "user@test.com", pass: "secret" },
      }),
    );
    expect(sendMailFn).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "no-reply@test.com",
        to: "destino@test.com",
        subject: "Asunto",
        html: "<p>hola</p>",
      }),
    );
  });
});
