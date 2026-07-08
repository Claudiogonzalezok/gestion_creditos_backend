jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const queries = require("./payments.queries");

describe("payments.queries", () => {
  it("reprograma cuotas mensuales adelantadas por mes calendario (1 month)", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await queries.shiftInstallmentDates(
      client,
      "credit-1",
      "MONTHLY",
      "2026-01-01",
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("$2::interval"),
      ["credit-1", "1 month", "2026-01-01"],
    );
  });
});
