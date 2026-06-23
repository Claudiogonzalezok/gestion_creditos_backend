// Test unitario del job weeklyReportEmail: verifica que reusa
// reports.service.getSummaryReport() y dispara notify() solo por email.

jest.mock("../utils/cronLogger", () => ({
  runWithLogging: jest.fn((name, fn) => fn()),
}));
jest.mock("../modules/reports/reports.service", () => ({
  getSummaryReport: jest.fn(),
}));
jest.mock("../modules/notifications/notifications.service", () => ({
  notify: jest.fn(),
}));
jest.mock("../modules/notifications/notifications.queries", () => ({
  getActiveAdminUserIds: jest.fn(),
}));

const reportsService = require("../modules/reports/reports.service");
const notificationsService = require("../modules/notifications/notifications.service");
const notificationsQueries = require("../modules/notifications/notifications.queries");
const { sendWeeklyReportEmail } = require("./weeklyReportEmail.job");

describe("weeklyReportEmail.job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("usa getSummaryReport() y llama a notify() solo con el canal email", async () => {
    reportsService.getSummaryReport.mockResolvedValue({
      total_collected: 1000,
    });
    notificationsQueries.getActiveAdminUserIds.mockResolvedValue([
      "admin-1",
      "admin-2",
    ]);

    const result = await sendWeeklyReportEmail();

    expect(reportsService.getSummaryReport).toHaveBeenCalledTimes(1);
    expect(notificationsService.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WEEKLY_REPORT",
        targetUserIds: ["admin-1", "admin-2"],
        channels: ["email"],
      }),
    );
    expect(result.affected_rows).toBe(2);
  });
});
