// P08 — contrato HTTP de POST /payments con client_request_id:
//   · creación nueva → 201
//   · replay idempotente (misma clave) → 200 con la pre-carga existente
//   · clave reusada para otro cobro → 409 con code IDEMPOTENCY_KEY_REUSED

jest.mock("./payments.service", () => ({ create: jest.fn() }));

const service = require("./payments.service");
const controller = require("./payments.controller");

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe("payments.controller.create — idempotencia (P08)", () => {
  const req = { body: { installment_id: "inst-1" }, user: { id: "u-1" } };

  beforeEach(() => jest.clearAllMocks());

  it("responde 201 cuando la pre-carga es nueva", async () => {
    service.create.mockResolvedValue({ id: "pay-1", status: "PENDING" });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].data).toEqual({ id: "pay-1", status: "PENDING" });
  });

  it("responde 200 con la pre-carga existente en un replay idempotente", async () => {
    const existing = { id: "pay-1", status: "PENDING", idempotent_replay: true };
    service.create.mockResolvedValue(existing);
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual(existing);
  });

  it("responde 409 con code IDEMPOTENCY_KEY_REUSED si la clave se reusó para otro cobro", async () => {
    service.create.mockRejectedValue({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
      message: "El client_request_id ya se usó para otro cobro.",
    });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("un 409 de negocio sin code se responde como antes (sin campo code)", async () => {
    service.create.mockRejectedValue({ status: 409, message: "Esta cuota ya fue pagada." });
    const res = mockRes();

    await controller.create(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("code");
  });
});
