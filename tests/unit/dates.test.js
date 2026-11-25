// Los helpers de fecha deben calcular "hoy" en la misma zona horaria que usa
// la sesión de PostgreSQL (src/config/db.js), no en la zona local del proceso.
const { today, daysAgo, daysFromNow } = require("../integration/helpers/dates");

describe("helpers de fecha de integración", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    jest.useRealTimers();
    process.env.TZ = originalTz;
  });

  it("a las 01:30 UTC, hoy en Buenos Aires sigue siendo el día anterior", () => {
    process.env.TZ = "America/Argentina/Buenos_Aires";
    jest.useFakeTimers().setSystemTime(new Date("2026-03-01T01:30:00Z"));

    expect(today()).toBe("2026-02-28");
    expect(daysAgo(1)).toBe("2026-02-27");
    expect(daysFromNow(1)).toBe("2026-03-01");
  });

  it("sin TZ usa la zona por defecto de db.js (Buenos Aires)", () => {
    delete process.env.TZ;
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T02:00:00Z"));

    expect(today()).toBe("2025-12-31");
  });

  it("con TZ=UTC usa la fecha UTC", () => {
    process.env.TZ = "UTC";
    jest.useFakeTimers().setSystemTime(new Date("2026-03-01T01:30:00Z"));

    expect(today()).toBe("2026-03-01");
    expect(daysAgo(30)).toBe("2026-01-30");
  });
});
