const express = require("express");
const request = require("supertest");

jest.mock("./reports.controller", () => ({
  getCollectionReport: jest.fn((req, res) =>
    res.status(200).json({ ok: true }),
  ),
  getPortfolioReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getOverdueReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getCollectorsReport: jest.fn((req, res) =>
    res.status(200).json({ ok: true }),
  ),
  getSellersReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getProductsReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getUpcomingReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getSummaryReport: jest.fn((req, res) => res.status(200).json({ ok: true })),
  getPaymentsOverdue48h: jest.fn((req, res) =>
    res.status(200).json({ ok: true }),
  ),
  getCashConversionsReport: jest.fn((req, res) =>
    res.status(200).json({ ok: true }),
  ),
  getCashMovementsReport: jest.fn((req, res) =>
    res.status(200).json({ ok: true, data: req.query }),
  ),
  getGeneralCashMovementsReport: jest.fn((req, res) =>
    res.status(200).json({ ok: true, data: req.query }),
  ),
}));

jest.mock("../../middlewares/auth.middleware", () => ({
  authenticate: (req, res, next) => {
    req.user = { id: "admin-1", role: "ADMIN" };
    next();
  },
  authorize: () => (req, res, next) => next(),
}));

const controller = require("./reports.controller");
const router = require("./reports.routes");

describe("reports.routes — GET /cash-movements", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/reports", router);
  });

  it("rechaza la petición sin cash_session_id", async () => {
    const res = await request(app).get("/reports/cash-movements");

    expect(res.status).toBe(400);
    expect(controller.getCashMovementsReport).not.toHaveBeenCalled();
  });

  it("rechaza cash_session_id que no es un UUID válido", async () => {
    const res = await request(app).get(
      "/reports/cash-movements?cash_session_id=no-es-un-uuid",
    );

    expect(res.status).toBe(400);
    expect(controller.getCashMovementsReport).not.toHaveBeenCalled();
  });

  it("acepta un cash_session_id UUID válido y llega al controlador", async () => {
    const cashSessionId = "550e8400-e29b-41d4-a716-446655440000";
    const res = await request(app).get(
      `/reports/cash-movements?cash_session_id=${cashSessionId}`,
    );

    expect(res.status).toBe(200);
    expect(controller.getCashMovementsReport).toHaveBeenCalled();
    expect(res.body.data.cash_session_id).toBe(cashSessionId);
  });
});
