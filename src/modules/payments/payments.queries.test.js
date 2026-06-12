jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const queries = require("./payments.queries");

describe("payments.queries", () => {
  it("reprograma cuotas mensuales adelantadas cada 30 días corridos — CR-24/CR-26", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    await queries.shiftInstallmentDates(
      client,
      "credit-1",
      "MONTHLY",
      "2026-01-01",
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("$2::interval"),
      ["credit-1", "30 days", "2026-01-01"],
    );
  });
});
