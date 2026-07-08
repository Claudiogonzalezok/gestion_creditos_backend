// Integración del flujo de cuotas adelantadas AL APROBAR una venta, unificado en
// `payments` como única fuente de verdad. Usa el SERVICIO real + el QUERY real
// (`createApprovalPrepaymentPayment`) contra un client transaccional simulado que
// captura el SQL, sin DB real. Verifica simultáneamente: pagos generados, estado
// de las cuotas, imputación a caja (cash_session_id), traza para reportes
// (generation_type) y agrupación (batch_id). Si se dispone de una DB de test
// dedicada, puede agregarse una variante que corra contra Postgres real.

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("./cash_movements.queries", () => ({ create: jest.fn() }));
jest.mock("../cashSessions/cashSessions.queries", () => ({
  lockActiveSessionForCurrentJornada: jest.fn(),
}));
jest.mock("../businessDays/businessDays.queries", () => ({
  findDefaultBranch: jest.fn(),
}));
jest.mock("../businessDays/businessDays.service", () => ({
  getActiveJornadaDate: jest.fn(),
}));
jest.mock("../collections/collections.queries", () => ({
  updateManagementStatusForActiveTodaySheet: jest.fn(),
}));
jest.mock("../systemConfig/systemConfig.queries", () => ({
  getValue: jest.fn().mockResolvedValue("3"),
}));
jest.mock("../../utils/transaction", () => ({ withTransaction: jest.fn() }));
jest.mock("../../utils/date", () => ({ localDate: jest.fn(() => "2026-05-01") }));
jest.mock("../notifications/notifications.service", () => ({}));
jest.mock("../notifications/notifications.queries", () => ({}));

// IMPORTANTE: NO se mockea ./payments.queries — se usa el SQL real.
const service = require("./payments.service");

/** Client transaccional simulado: captura cada query (sql + params). */
const makeFakeClient = () => {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    }),
  };
};

const round2 = (n) => Math.round(n * 100) / 100;

describe("generatePrepaidInstallmentPayments — unificación en payments", () => {
  const baseParams = {
    adminId: "admin-1",
    cashSessionId: "session-1",
    batchId: "batch-xyz",
  };

  it("genera un payment APROBADO por cuota (todo efectivo), deja la cuota como cobro normal y agrupa por batch_id", async () => {
    const client = makeFakeClient();
    const installments = [
      { id: "i1", amountDue: 10000 },
      { id: "i2", amountDue: 10000 },
      { id: "i3", amountDue: 10000 },
    ];

    const result = await service.generatePrepaidInstallmentPayments(client, {
      ...baseParams,
      installments,
      amountCash: 30000,
      amountTransfer: 0,
    });

    const inserts = client.calls.filter((c) =>
      c.sql.includes("INSERT INTO payments"),
    );
    const updates = client.calls.filter((c) =>
      c.sql.includes("UPDATE installments"),
    );

    // Un pago + un update de cuota por cada cuota adelantada.
    expect(inserts).toHaveLength(3);
    expect(updates).toHaveLength(3);

    // Trazabilidad tipada + agrupación + imputación a caja en cada pago.
    for (const ins of inserts) {
      expect(ins.sql).toContain("'APPROVAL_PREPAYMENT'");
      expect(ins.sql).toContain("'APPROVED'");
      expect(ins.sql).toContain("batch_id");
      expect(ins.sql).toContain("cash_session_id");
      // params: [instId, adminId, received, cash, transfer, method, ref, session, batch]
      expect(ins.params[7]).toBe("session-1"); // cash_session_id
      expect(ins.params[8]).toBe("batch-xyz"); // batch_id mismo para todos
      expect(ins.params[5]).toBe("CASH");
    }

    // Las cuotas quedan PAID = amount_due (idéntico a un cobro normal).
    for (const upd of updates) {
      expect(upd.sql).toContain("status = 'PAID'");
      expect(upd.sql).toContain("amount_paid = amount_due");
    }

    // NO se crea credit_down_payments: única fuente de verdad = payments.
    expect(
      client.calls.some((c) => c.sql.includes("credit_down_payments")),
    ).toBe(false);

    // Suma de lo recibido === total del adelanto.
    const sumReceived = round2(
      inserts.reduce((s, ins) => s + ins.params[2], 0),
    );
    expect(sumReceived).toBe(30000);
    expect(result).toEqual({ total: 30000, count: 3, batchId: "batch-xyz" });
  });

  it("prorratea efectivo/transferencia en pago mixto y el resto de redondeo va a la última cuota (sumas exactas)", async () => {
    const client = makeFakeClient();
    const installments = [
      { id: "i1", amountDue: 10000 },
      { id: "i2", amountDue: 10000 },
      { id: "i3", amountDue: 10000 },
    ];

    // 20000 efectivo + 10000 transferencia sobre 30000.
    await service.generatePrepaidInstallmentPayments(client, {
      ...baseParams,
      installments,
      amountCash: 20000,
      amountTransfer: 10000,
    });

    const inserts = client.calls.filter((c) =>
      c.sql.includes("INSERT INTO payments"),
    );
    const sumCash = round2(inserts.reduce((s, i) => s + i.params[3], 0));
    const sumTransfer = round2(inserts.reduce((s, i) => s + i.params[4], 0));
    const sumReceived = round2(inserts.reduce((s, i) => s + i.params[2], 0));

    // El desglose por medio cuadra EXACTO con el bloque del adelanto.
    expect(sumCash).toBe(20000);
    expect(sumTransfer).toBe(10000);
    expect(sumReceived).toBe(30000);

    // Cada pago: amount_cash + amount_transfer === amount_received (CHECK mig 032).
    for (const ins of inserts) {
      expect(round2(ins.params[3] + ins.params[4])).toBe(ins.params[2]);
    }
  });

  it("aborta (throw) si la suma del adelanto no coincide con el total de las cuotas, sin escribir nada", async () => {
    const client = makeFakeClient();
    const installments = [
      { id: "i1", amountDue: 10000 },
      { id: "i2", amountDue: 10000 },
    ];

    await expect(
      service.generatePrepaidInstallmentPayments(client, {
        ...baseParams,
        installments,
        amountCash: 15000, // 15000 != 20000 → inconsistente
        amountTransfer: 0,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Rollback-safe: no se ejecutó ninguna escritura.
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rechaza si no hay cuotas adelantadas", async () => {
    const client = makeFakeClient();
    await expect(
      service.generatePrepaidInstallmentPayments(client, {
        ...baseParams,
        installments: [],
        amountCash: 0,
        amountTransfer: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
