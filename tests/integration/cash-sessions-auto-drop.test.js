// Auto-fondeo a Caja General al cerrar/reconciliar una cash_session.
//
// Verifica el comportamiento agregado por sdd/auto-drop-on-cash-session-close:
//   · close() y reconcile() generan UN movimiento DROP_IN en Caja General
//     por declared.cash + declared.transfer, con split correcto.
//   · declared = 0 → no genera movimiento.
//   · Solo uno de los dos montos > 0 → un único movimiento con el split parcial.
//   · Trazabilidad: reference_type='CASH_SESSION_CLOSURE', reference_id=session.id.
//   · Idempotencia: el índice único cam_one_drop_in_per_closure_idx evita duplicados.

const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const cashSessions = require("../../src/modules/cashSessions/cashSessions.service");
const cashAccountsQueries = require("../../src/modules/cashAccounts/cashAccounts.queries");
const cashAccountsService = require("../../src/modules/cashAccounts/cashAccounts.service");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe("Auto-drop a Caja General al cerrar caja operativa — close()", () => {
  it("declared.cash > 0 y declared.transfer > 0 → genera UN movimiento DROP_IN con split correcto y suma a current_balance", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    const general = await cashAccountsQueries.findGeneralCashAccount();
    const balanceBefore = general.current_balance;

    await cashSessions.close(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 500 },
          { payment_method: "TRANSFER", declared_amount: 200 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });

    expect(movement).not.toBeNull();
    expect(movement.amount).toBeCloseTo(700, 2);
    expect(movement.amount_cash).toBeCloseTo(500, 2);
    expect(movement.amount_transfer).toBeCloseTo(200, 2);
    expect(movement.direction).toBe("IN");
    expect(movement.reference_type).toBe("CASH_SESSION_CLOSURE");
    expect(movement.reference_id).toBe(cs.id);

    const generalAfter = await cashAccountsQueries.findById(general.id);
    expect(generalAfter.current_balance).toBeCloseTo(balanceBefore + 700, 2);
  });

  it("declared.cash = 0 y declared.transfer = 0 → NO genera movimiento ni cambia el balance", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    const general = await cashAccountsQueries.findGeneralCashAccount();
    const balanceBefore = general.current_balance;

    await cashSessions.close(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 0 },
          { payment_method: "TRANSFER", declared_amount: 0 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });
    expect(movement).toBeNull();

    const generalAfter = await cashAccountsQueries.findById(general.id);
    expect(generalAfter.current_balance).toBeCloseTo(balanceBefore, 2);
  });

  it("solo declared.cash > 0 → UN único movimiento con el split parcial (transfer=0)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    await cashSessions.close(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 300 },
          { payment_method: "TRANSFER", declared_amount: 0 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });

    expect(movement).not.toBeNull();
    expect(movement.amount).toBeCloseTo(300, 2);
    expect(movement.amount_cash).toBeCloseTo(300, 2);
    expect(movement.amount_transfer).toBe(0);
  });

  it("reintento tras fallo en insertMovementWithBalance → rollback completo, sin cierre ni movimiento huérfano; reintento exitoso genera exactamente UN movimiento", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(admin));

    // Forzamos un fallo a mitad de transacción simulando un error en
    // insertMovementWithBalance (p.ej. cuenta inactiva).
    const spy = jest
      .spyOn(cashAccountsService, "insertMovementWithBalance")
      .mockRejectedValueOnce({
        status: 409,
        message: "Cuenta inactiva (simulado)",
      });

    await expect(
      cashSessions.close(
        cs.id,
        {
          declared: [
            { payment_method: "CASH", declared_amount: 500 },
            { payment_method: "TRANSFER", declared_amount: 200 },
          ],
        },
        asUser(admin),
      ),
    ).rejects.toMatchObject({ status: 409 });

    spy.mockRestore();

    // La sesión sigue OPEN (rollback completo, no quedó en CLOSED).
    const after = await cashSessions.getById(cs.id);
    expect(after.status).toBe("OPEN");

    // No quedó movimiento huérfano.
    const noMovement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });
    expect(noMovement).toBeNull();

    // Reintento exitoso.
    await cashSessions.close(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 500 },
          { payment_method: "TRANSFER", declared_amount: 200 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });
    expect(movement).not.toBeNull();
    expect(movement.amount).toBeCloseTo(700, 2);
  });
});

describe("Auto-drop a Caja General al cerrar caja operativa — reconcile()", () => {
  it("declared > 0 en reconcile() → genera movimiento DROP_IN y suma a current_balance", async () => {
    const owner = await createUserFixture({ role: "ADMIN" });
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(owner));
    await cashSessions.markPending(cs.id, { reason: "olvido" }, asUser(owner));

    const general = await cashAccountsQueries.findGeneralCashAccount();
    const balanceBefore = general.current_balance;

    await cashSessions.reconcile(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 150 },
          { payment_method: "TRANSFER", declared_amount: 50 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });
    expect(movement).not.toBeNull();
    expect(movement.amount).toBeCloseTo(200, 2);
    expect(movement.amount_cash).toBeCloseTo(150, 2);
    expect(movement.amount_transfer).toBeCloseTo(50, 2);

    const generalAfter = await cashAccountsQueries.findById(general.id);
    expect(generalAfter.current_balance).toBeCloseTo(balanceBefore + 200, 2);
  });

  it("declared = 0 en reconcile() → NO genera movimiento", async () => {
    const owner = await createUserFixture({ role: "ADMIN" });
    const admin = await createUserFixture({ role: "ADMIN" });
    const cs = await cashSessions.open({ opening_amount: 0 }, asUser(owner));
    await cashSessions.markPending(cs.id, { reason: "olvido" }, asUser(owner));

    await cashSessions.reconcile(
      cs.id,
      {
        declared: [
          { payment_method: "CASH", declared_amount: 0 },
          { payment_method: "TRANSFER", declared_amount: 0 },
        ],
      },
      asUser(admin),
    );

    const movement = await cashAccountsQueries.findMovementByReference({
      referenceType: "CASH_SESSION_CLOSURE",
      referenceId: cs.id,
      movementType: "DROP_IN",
    });
    expect(movement).toBeNull();
  });
});
