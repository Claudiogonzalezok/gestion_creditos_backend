jest.mock("../../config/db", () => ({ query: jest.fn() }));

const queries = require("./cashAccounts.queries");

// Confirma el contrato de las queries que usará el helper
// transferDeclaredToGeneralCash (cashSessions.service.js):
//   · findGeneralCashAccount: soporta `client` transaccional, devuelve null si no hay cuenta.
//   · findMovementByReference: soporta filtro por referenceType/referenceId/movementType
//     y `client` transaccional, devuelve null si no hay movimiento.
describe("cashAccounts.queries — soporte para auto-drop de cierre", () => {
  it("findGeneralCashAccount acepta un client transaccional y devuelve null si no hay fila", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    const result = await queries.findGeneralCashAccount(client);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain("GENERAL_CASH");
    expect(result).toBeNull();
  });

  it("findGeneralCashAccount devuelve la cuenta cuando existe", async () => {
    const general = { id: "acc-1", type: "GENERAL_CASH", current_balance: 0 };
    const client = { query: jest.fn().mockResolvedValue({ rows: [general] }) };

    const result = await queries.findGeneralCashAccount(client);

    expect(result).toEqual(general);
  });

  it("findMovementByReference filtra por referenceType + referenceId + movementType y devuelve null si no existe", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    const result = await queries.findMovementByReference(
      {
        referenceType: "CASH_SESSION_CLOSURE",
        referenceId: "session-1",
        movementType: "DROP_IN",
      },
      client,
    );

    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("reference_type = $1");
    expect(sql).toContain("reference_id = $2");
    expect(sql).toContain("movement_type = $3");
    expect(params).toEqual(["CASH_SESSION_CLOSURE", "session-1", "DROP_IN"]);
    expect(result).toBeNull();
  });

  it("findMovementByReference devuelve el movimiento existente (idempotencia)", async () => {
    const movement = {
      id: "mov-1",
      cash_account_id: "acc-1",
      movement_type: "DROP_IN",
      reference_type: "CASH_SESSION_CLOSURE",
      reference_id: "session-1",
    };
    const client = { query: jest.fn().mockResolvedValue({ rows: [movement] }) };

    const result = await queries.findMovementByReference(
      {
        referenceType: "CASH_SESSION_CLOSURE",
        referenceId: "session-1",
        movementType: "DROP_IN",
      },
      client,
    );

    expect(result).toEqual(movement);
  });
});
