// Test unitario del job installmentDueSoon: verifica que una cuota a 3 días
// de vencer genera notify() con el tipo correcto.

jest.mock("../config/db", () => ({ query: jest.fn() }));
jest.mock("../utils/cronLogger", () => ({
  runWithLogging: jest.fn((name, fn) => fn()),
  ts: () => "",
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
const { checkInstallmentsDueSoon } = require("./installmentDueSoon.job");

describe("installmentDueSoon.job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("llama a notify() con type INSTALLMENT_DUE por cada cuota a 3 días de vencer", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          id: "inst-1",
          installment_number: 2,
          due_date: "2026-07-01",
          credit_id: "credit-1",
          customer_name: "Cliente Test",
        },
      ],
    });
    notificationsQueries.getActiveAdminUserIds.mockResolvedValue(["admin-1"]);

    const result = await checkInstallmentsDueSoon();

    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "INSTALLMENT_DUE",
        targetUserIds: ["admin-1"],
        entityType: "credit",
        entityId: "credit-1",
      }),
    );
    expect(result.affected_rows).toBe(1);
  });

  it("no llama a notify() si no hay cuotas a 3 días de vencer", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await checkInstallmentsDueSoon();

    expect(notificationsService.notify).not.toHaveBeenCalled();
    expect(result.affected_rows).toBe(0);
  });
});
