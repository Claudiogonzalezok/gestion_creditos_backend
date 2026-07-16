jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const pool = require("../../config/db");
const queries = require("./notifications.queries");

describe("notifications.queries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getPreferences", () => {
    it("filtra preferencias por los tipos soportados para no exponer filas legacy", async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await queries.getPreferences();

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE type = ANY($1::text[])"),
        [queries.NOTIFICATION_TYPES],
      );
    });
  });
});
