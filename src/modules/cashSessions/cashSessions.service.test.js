jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../cashAccounts/cashAccounts.queries");
jest.mock("../cashAccounts/cashAccounts.service");

const cashAccountsQueries = require("../cashAccounts/cashAccounts.queries");
const cashAccountsService = require("../cashAccounts/cashAccounts.service");
const { transferDeclaredToGeneralCash } = require("./cashSessions.service");

describe("cashSessions.service.transferDeclaredToGeneralCash", () => {
  const client = { query: jest.fn() };
  const session = { id: "session-1", owner_user_id: "user-1" };
  const general = { id: "general-acc-1", type: "GENERAL_CASH" };

  beforeEach(() => {
    jest.clearAllMocks();
    cashAccountsQueries.findGeneralCashAccount.mockResolvedValue(general);
    cashAccountsQueries.findMovementByReference.mockResolvedValue(null);
    cashAccountsService.insertMovementWithBalance.mockResolvedValue({
      movement: { id: "mov-1" },
      newBalance: 700,
    });
    client.query.mockResolvedValue({ rows: [{ full_name: "Cajero Uno" }] });
  });

  it("total declarado = 0 → no llama insertMovementWithBalance y devuelve null", async () => {
    const result = await transferDeclaredToGeneralCash(client, {
      session,
      declared: { cash: 0, transfer: 0 },
      capturedBy: "user-2",
    });

    expect(result).toBeNull();
    expect(
      cashAccountsService.insertMovementWithBalance,
    ).not.toHaveBeenCalled();
  });

  it("total declarado > 0 → llama insertMovementWithBalance con el split correcto y referencia al cierre", async () => {
    const result = await transferDeclaredToGeneralCash(client, {
      session,
      declared: { cash: 500, transfer: 200 },
      capturedBy: "user-2",
    });

    expect(cashAccountsQueries.findGeneralCashAccount).toHaveBeenCalledWith(
      client,
    );
    expect(cashAccountsService.insertMovementWithBalance).toHaveBeenCalledTimes(
      1,
    );

    const [calledClient, params] =
      cashAccountsService.insertMovementWithBalance.mock.calls[0];
    expect(calledClient).toBe(client);
    expect(params).toMatchObject({
      cashAccountId: general.id,
      movementType: "DROP_IN",
      direction: "IN",
      amount: 700,
      amountCash: 500,
      amountTransfer: 200,
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: session.id,
      createdBy: "user-2",
      beneficiaryName: "Cajero Uno",
    });
    expect(result).toEqual({ id: "mov-1" });
  });

  it("solo cash > 0 → split correcto (transfer en 0)", async () => {
    await transferDeclaredToGeneralCash(client, {
      session,
      declared: { cash: 300, transfer: 0 },
      capturedBy: "user-2",
    });

    const [, params] =
      cashAccountsService.insertMovementWithBalance.mock.calls[0];
    expect(params.amount).toBe(300);
    expect(params.amountCash).toBe(300);
    expect(params.amountTransfer).toBe(0);
  });

  it("idempotencia: si findMovementByReference ya devuelve un movimiento, no inserta de nuevo", async () => {
    const existing = { id: "mov-existing" };
    cashAccountsQueries.findMovementByReference.mockResolvedValue(existing);

    const result = await transferDeclaredToGeneralCash(client, {
      session,
      declared: { cash: 500, transfer: 200 },
      capturedBy: "user-2",
    });

    expect(
      cashAccountsService.insertMovementWithBalance,
    ).not.toHaveBeenCalled();
    expect(result).toEqual(existing);
  });

  it("findMovementByReference se llama con referenceType=CASH_SESSION_CLOSURE, referenceId=session.id y movementType=DROP_IN", async () => {
    await transferDeclaredToGeneralCash(client, {
      session,
      declared: { cash: 500, transfer: 200 },
      capturedBy: "user-2",
    });

    expect(cashAccountsQueries.findMovementByReference).toHaveBeenCalledWith(
      {
        referenceType: "CASH_SESSION_CLOSURE",
        referenceId: session.id,
        movementType: "DROP_IN",
      },
      client,
    );
  });

  it("no hay Caja General configurada → lanza 500", async () => {
    cashAccountsQueries.findGeneralCashAccount.mockResolvedValue(null);

    await expect(
      transferDeclaredToGeneralCash(client, {
        session,
        declared: { cash: 100, transfer: 0 },
        capturedBy: "user-2",
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
