// Bloque P — Integración Caja General (Fase 3)
//
// Cubre los flujos cross-module que materializan movimientos automáticos en
// cash_account_movements:
//   · cashSessions.addDrop  → DROP_IN auto en la cuenta destino.
//   · commissions.liquidate → SALARY_PAYMENT en Caja General (sin caja del admin).

const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const cashAccountsService = require("../../src/modules/cashAccounts/cashAccounts.service");
const cashAccountsQueries = require("../../src/modules/cashAccounts/cashAccounts.queries");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const commissionsService = require("../../src/modules/commissions/commissions.service");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });
const getGeneralCashAccount = () =>
  cashAccountsQueries.findGeneralCashAccount();

/**
 * Inserta una comisión PENDING para el cobrador, atada a un crédito mínimo.
 * Devuelve el id de la comisión creada.
 */
const seedPendingCommission = async (userId, amount) => {
  const cust = (
    await pool.query(
      `INSERT INTO customers (full_name, dni, status) VALUES ('Cli','${String(Date.now()).slice(-9)}','ACTIVE') RETURNING id`,
    )
  ).rows[0];
  const cred = (
    await pool.query(
      `INSERT INTO credits (customer_id, type, total_amount, installments_count, payment_frequency, status, created_by)
     VALUES ($1, 'SALE', 10000, 1, 'WEEKLY', 'ACTIVE', $2) RETURNING id`,
      [cust.id, userId],
    )
  ).rows[0];
  const r = await pool.query(
    `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end)
     VALUES ($1, $2, $3, 'PENDING', '2026-06-01', '2026-06-07') RETURNING id`,
    [userId, cred.id, amount],
  );
  return r.rows[0].id;
};

describe("P — Integración Caja General (drops + commissions)", () => {
  // ── addDrop → DROP_IN automático ────────────────────────────────────────
  describe("cashSessions.addDrop genera DROP_IN automático", () => {
    it("default a Caja General cuando no se pasa destination_account_id", async () => {
      const acc = await getGeneralCashAccount();
      const collector = await createUserFixture({
        role: "COLLECTOR",
        full_name: "Juan Cobrador",
      });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(collector),
      );

      const drop = await cashSessionsService.addDrop(
        session.id,
        {
          amount: 1500,
          payment_method: "CASH",
        },
        asUser(collector),
      );

      expect(drop.destination_account_id).toBe(acc.id);

      const movs = await cashAccountsService.listMovements(acc.id, {});
      expect(movs.pagination.total).toBe(1);
      const dropIn = movs.items[0];
      expect(dropIn).toMatchObject({
        movement_type: "DROP_IN",
        direction: "IN",
        amount: 1500,
        beneficiary_name: "Juan Cobrador",
        reference_type: "CASH_SESSION_DROP",
        reference_id: drop.id,
        created_by: collector.id,
      });

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(1500);
    });

    it("respeta destination_account_id explícito si la cuenta existe y está activa", async () => {
      const acc = await getGeneralCashAccount(); // hoy hay una sola cuenta válida
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(collector),
      );

      const drop = await cashSessionsService.addDrop(
        session.id,
        {
          amount: 800,
          payment_method: "CASH",
          destination_account_id: acc.id,
        },
        asUser(collector),
      );

      expect(drop.destination_account_id).toBe(acc.id);
      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(800);
    });

    it("rechaza destination_account_id inexistente con 404", async () => {
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(collector),
      );

      await expect(
        cashSessionsService.addDrop(
          session.id,
          {
            amount: 100,
            payment_method: "CASH",
            destination_account_id: "00000000-0000-0000-0000-000000000000",
          },
          asUser(collector),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("rechaza destination_account_id de cuenta inactiva con 404", async () => {
      const acc = await getGeneralCashAccount();
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(collector),
      );

      await pool.query(
        `UPDATE cash_accounts SET is_active = FALSE WHERE id = $1`,
        [acc.id],
      );
      try {
        await expect(
          cashSessionsService.addDrop(
            session.id,
            {
              amount: 100,
              payment_method: "CASH",
              destination_account_id: acc.id,
            },
            asUser(collector),
          ),
        ).rejects.toMatchObject({ status: 404 });
      } finally {
        // Reactivar para que el truncate del próximo test no rompa otros suites.
        await pool.query(
          `UPDATE cash_accounts SET is_active = TRUE WHERE id = $1`,
          [acc.id],
        );
      }
    });

    it("drop TRANSFER también genera DROP_IN (independiente del payment_method)", async () => {
      const acc = await getGeneralCashAccount();
      const collector = await createUserFixture({ role: "COLLECTOR" });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(collector),
      );

      await cashSessionsService.addDrop(
        session.id,
        {
          amount: 700,
          payment_method: "TRANSFER",
          receipt_reference: "TX-001",
        },
        asUser(collector),
      );

      const movs = await cashAccountsService.listMovements(acc.id, {
        movementType: "DROP_IN",
      });
      expect(movs.pagination.total).toBe(1);
      expect(movs.items[0].amount).toBe(700);

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(700);
    });

    it("múltiples drops en la única caja de la jornada acumulan correctamente el balance", async () => {
      // V4.6: una sola caja por jornada, siempre — no hay turnos secuenciales.
      // Varios drops dentro de la misma caja deben acumular igual.
      const acc = await getGeneralCashAccount();
      const u1 = await createUserFixture({ role: "ADMIN" });

      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(u1),
      );
      await cashSessionsService.addDrop(
        session.id,
        { amount: 1000, payment_method: "CASH" },
        asUser(u1),
      );
      await cashSessionsService.addDrop(
        session.id,
        { amount: 250, payment_method: "TRANSFER" },
        asUser(u1),
      );
      await cashSessionsService.addDrop(
        session.id,
        { amount: 500, payment_method: "CASH" },
        asUser(u1),
      );

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(1750);

      const movs = await cashAccountsService.listMovements(acc.id, {
        movementType: "DROP_IN",
      });
      expect(movs.pagination.total).toBe(3);
    });

    it("rechaza abrir una segunda caja en la misma jornada después de cerrar la primera", async () => {
      const u1 = await createUserFixture({ role: "ADMIN" });
      const session = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(u1),
      );
      await cashSessionsService.close(
        session.id,
        {
          declared: [{ payment_method: "CASH", declared_amount: 0 }],
        },
        asUser(u1),
      );

      await expect(
        cashSessionsService.open({ opening_amount: 0 }, asUser(u1)),
      ).rejects.toMatchObject({
        status: 409,
        code: "ACTIVE_SESSION_IN_BUSINESS_DAY",
      });
    });
  });

  // ── commissions.liquidate → SALARY_PAYMENT en Caja General ──────────────
  describe("commissions.liquidate imputa SALARY_PAYMENT a Caja General", () => {
    it("happy path: liquidación crea SALARY_PAYMENT con beneficiary y reference correctos", async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: "ADMIN" });
      const collector = await createUserFixture({
        role: "COLLECTOR",
        full_name: "Maria Cobradora",
      });

      // Cargo Caja General con $5000.
      await cashAccountsService.registerMovement(
        acc.id,
        {
          movementType: "ADJUSTMENT",
          direction: "IN",
          amount: 5000,
        },
        asUser(admin),
      );

      await seedPendingCommission(collector.id, 800);

      const liq = await commissionsService.liquidate(
        {
          user_id: collector.id,
          payment_method: "CASH",
        },
        admin.id,
      );

      expect(liq.total_paid).toBe(800);
      expect(liq.cash_session_id).toBeNull(); // ya no se imputa a caja del admin

      const movs = await cashAccountsService.listMovements(acc.id, {
        movementType: "SALARY_PAYMENT",
      });
      expect(movs.pagination.total).toBe(1);
      expect(movs.items[0]).toMatchObject({
        movement_type: "SALARY_PAYMENT",
        direction: "OUT",
        amount: 800,
        beneficiary_name: "Maria Cobradora",
        reference_type: "COMMISSION_LIQUIDATION",
        reference_id: liq.id,
        created_by: admin.id,
      });

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(4200);
    });

    it("no exige caja OPEN del admin (es operación de tesorería)", async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: "ADMIN" });
      const collector = await createUserFixture({ role: "COLLECTOR" });

      await cashAccountsService.registerMovement(
        acc.id,
        {
          movementType: "ADJUSTMENT",
          direction: "IN",
          amount: 1000,
        },
        asUser(admin),
      );
      await seedPendingCommission(collector.id, 400);

      // Admin sin caja OPEN — no debe fallar.
      const adminOpens = await pool.query(
        `SELECT count(*)::int AS n FROM cash_sessions WHERE owner_user_id=$1 AND status='OPEN'`,
        [admin.id],
      );
      expect(adminOpens.rows[0].n).toBe(0);

      const liq = await commissionsService.liquidate(
        {
          user_id: collector.id,
          payment_method: "CASH",
        },
        admin.id,
      );
      expect(liq).toBeDefined();
    });

    it("sin fondos en Caja General → 409 + rollback (comisión vuelve a PENDING)", async () => {
      const admin = await createUserFixture({ role: "ADMIN" });
      const collector = await createUserFixture({ role: "COLLECTOR" });

      const commId = await seedPendingCommission(collector.id, 800);

      await expect(
        commissionsService.liquidate(
          {
            user_id: collector.id,
            payment_method: "CASH",
          },
          admin.id,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "INSUFFICIENT_BALANCE",
      });

      // Comisión sigue PENDING; no se creó liquidation ni movement.
      const c = await pool.query(`SELECT status FROM commissions WHERE id=$1`, [
        commId,
      ]);
      expect(c.rows[0].status).toBe("PENDING");

      const liqs = await pool.query(
        `SELECT count(*)::int AS n FROM commission_liquidations`,
      );
      expect(liqs.rows[0].n).toBe(0);

      const acc = await getGeneralCashAccount();
      const movs = await cashAccountsService.listMovements(acc.id, {
        movementType: "SALARY_PAYMENT",
      });
      expect(movs.pagination.total).toBe(0);
    });

    it("la caja del admin no se ve afectada por liquidaciones (outflows_commissions deprecado)", async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: "ADMIN" });
      const collector = await createUserFixture({ role: "COLLECTOR" });

      // Abro caja del admin con opening 0 para tener referencia limpia.
      const adminSession = await cashSessionsService.open(
        { opening_amount: 0 },
        asUser(admin),
      );

      // Cargo Caja General y liquido.
      await cashAccountsService.registerMovement(
        acc.id,
        {
          movementType: "ADJUSTMENT",
          direction: "IN",
          amount: 3000,
        },
        asUser(admin),
      );
      await seedPendingCommission(collector.id, 500);
      await commissionsService.liquidate(
        {
          user_id: collector.id,
          payment_method: "CASH",
        },
        admin.id,
      );

      // El snapshot de la caja del admin NO debe contar la liquidación como egreso.
      const snap = await cashSessionsService.snapshot(adminSession.id);
      expect(snap.outflows.commissions.cash).toBe(0);
      expect(snap.outflows.commissions.transfer).toBe(0);
      expect(snap.expected.cash).toBe(0); // opening 0 — sin movimientos imputados a la caja del admin
    });
  });
});
