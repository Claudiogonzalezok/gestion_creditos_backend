const { parseTrustProxy, rateLimitMessage } = require("../../src/middlewares/rateLimit.helpers");

describe("parseTrustProxy", () => {
  it.each([
    [undefined, "loopback"],
    ["", "loopback"],
    ["loopback", "loopback"],
    ["true", true],
    ["FALSE", false],
    ["1", 1],
    ["10.0.0.0/8, uniquelocal", "10.0.0.0/8, uniquelocal"],
  ])("%p → %p", (input, expected) => {
    expect(parseTrustProxy(input)).toBe(expected);
  });
});

describe("rateLimitMessage", () => {
  it("usa los minutos restantes reales de la ventana", () => {
    const msg = rateLimitMessage("Demasiados intentos.")({
      rateLimit: { resetTime: new Date(Date.now() + 3 * 60 * 1000 - 500) },
    });
    expect(msg).toEqual({ ok: false, message: "Demasiados intentos. Intentá nuevamente en 3 minutos." });
  });

  it("singular y mínimo de 1 minuto sin resetTime", () => {
    expect(rateLimitMessage("X.")({}).message).toBe("X. Intentá nuevamente en 1 minuto.");
  });
});
