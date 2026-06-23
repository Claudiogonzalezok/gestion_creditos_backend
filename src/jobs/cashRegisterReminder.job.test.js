// Test unitario del job cashRegisterReminder: verifica que una jornada OPEN
// genera notify() con el tipo correcto.

jest.mock("../config/db", () => ({ query: jest.fn() }));
jest.mock("../utils/cronLogger", () => ({
  runWithLogging: jest.fn((name, fn) => fn()),
}));
jest.mock("../modules/notifications/notifications.service", () => ({
  notify: jest.fn(),
}));
jest.mock("../modules/notifications/notifications.queries", () => ({
  getActiveAdminUserIds: jest.fn(),
}));

const pool = require("../config/db");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");
const { checkOpenCashRegisters } = require("./cashRegisterReminder.job");

describe("cashRegisterReminder.job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("llama a notify() con type CASH_REGISTER por cada jornada OPEN", async () => {
    pool.query.mockResolvedValue({
      rows: [
        { id: "bd-1", business_date: "2026-06-23", branch_id: "branch-1" },
      ],
    });
    notificationsQueries.getActiveAdminUserIds.mockResolvedValue(["admin-1"]);

    const result = await checkOpenCashRegisters();

    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CASH_REGISTER",
        targetUserIds: ["admin-1"],
        channels: ["push", "email"],
        entityType: "business_day",
        entityId: "bd-1",
      }),
    );
    expect(result.affected_rows).toBe(1);
  });

  it("no llama a notify() si no hay jornadas abiertas", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await checkOpenCashRegisters();

    expect(notificationsService.notify).not.toHaveBeenCalled();
    expect(result.affected_rows).toBe(0);
  });
});
