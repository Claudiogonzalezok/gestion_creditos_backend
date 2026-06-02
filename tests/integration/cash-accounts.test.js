// Bloque O — Caja General (cash_accounts)
//
// Cubre la API y la lógica del módulo cashAccounts:
//   · Lectura básica (getAll, getById, getBalance).
//   · registerMovement con regla universal "saldo nunca negativo".
//   · Validaciones de direction y movement_type.
//   · Audit balance (cached vs computed) y detección de drift.
//   · listMovements con filtros + paginación.
//   · Integración cross-module: reverseDrop falla 409 si Caja General no
//     tiene saldo suficiente; toda la tx revierte (drop sigue ACTIVE).

const { pool, setupTestSuite }   = require('./helpers/db');
const { createUserFixture }      = require('./helpers/fixtures');
const cashAccountsService        = require('../../src/modules/cashAccounts/cashAccounts.service');
const cashAccountsQueries        = require('../../src/modules/cashAccounts/cashAccounts.queries');
const cashSessionsService        = require('../../src/modules/cashSessions/cashSessions.service');
const cashSessionsQueries        = require('../../src/modules/cashSessions/cashSessions.queries');

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

// Helper: rehidrata la cuenta General (que NO se trunca entre tests, pero su
// current_balance sí se resetea — ver tests/integration/helpers/db.js).
const getGeneralCashAccount = () => cashAccountsQueries.findGeneralCashAccount();

describe('O — Caja General (cash_accounts)', () => {
  // ── Lectura básica ──────────────────────────────────────────────────────
  describe('Lectura', () => {
    it('getAll devuelve la Caja General seed activa', async () => {
      const accounts = await cashAccountsService.getAll();
      expect(accounts.length).toBeGreaterThanOrEqual(1);
      const general = accounts.find((a) => a.type === 'GENERAL_CASH');
      expect(general).toBeDefined();
      expect(general.is_active).toBe(true);
      expect(general.current_balance).toBe(0);
    });

    it('getById de cuenta inexistente lanza 404', async () => {
      await expect(
        cashAccountsService.getById('00000000-0000-0000-0000-000000000000'),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('getBalance devuelve estructura mínima con current_balance', async () => {
      const acc = await getGeneralCashAccount();
      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal).toMatchObject({
        id: acc.id, name: 'Caja General', type: 'GENERAL_CASH', current_balance: 0,
      });
    });
  });

  // ── registerMovement happy path ─────────────────────────────────────────
  describe('registerMovement — happy path', () => {
    it('ADJUSTMENT IN suma al balance y persiste el movimiento', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });

      const result = await cashAccountsService.registerMovement(acc.id, {
        movementType: 'ADJUSTMENT', direction: 'IN', amount: 2500,
        description: 'Carga inicial', beneficiaryName: null,
      }, asUser(admin));

      expect(result.current_balance).toBe(2500);
      expect(result.movement).toMatchObject({
        movement_type: 'ADJUSTMENT', direction: 'IN', amount: 2500,
        description: 'Carga inicial', created_by: admin.id,
      });

      // Persistencia real
      const fresh = await cashAccountsService.getBalance(acc.id);
      expect(fresh.current_balance).toBe(2500);
    });

    it('SUPPLIER_PAYMENT con saldo suficiente descuenta y registra beneficiary_name', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await cashAccountsService.registerMovement(acc.id, {
        movementType: 'ADJUSTMENT', direction: 'IN', amount: 5000,
      }, asUser(admin));

      const result = await cashAccountsService.registerMovement(acc.id, {
        movementType: 'SUPPLIER_PAYMENT', amount: 1200,
        beneficiaryName: 'Proveedor XYZ S.A.', description: 'Compra mercadería',
      }, asUser(admin));

      expect(result.current_balance).toBe(3800);
      expect(result.movement.direction).toBe('OUT');
      expect(result.movement.beneficiary_name).toBe('Proveedor XYZ S.A.');
    });
  });

  // ── Regla universal "saldo nunca negativo" ──────────────────────────────
  describe('Regla universal de saldo no-negativo', () => {
    const buildLowFundsAccount = async (initialBalance = 100) => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      if (initialBalance > 0) {
        await cashAccountsService.registerMovement(acc.id, {
          movementType: 'ADJUSTMENT', direction: 'IN', amount: initialBalance,
        }, asUser(admin));
      }
      return { acc, admin };
    };

    // SALARY_PAYMENT no aparece acá porque IMP-6 lo sacó del endpoint público.
    // Su bloqueo por saldo se prueba indirectamente vía commissions.liquidate
    // (suite cash-accounts-integration).
    it.each([
      ['SUPPLIER_PAYMENT'],
      ['EXPENSE'],
    ])('%s con saldo insuficiente lanza 409 INSUFFICIENT_BALANCE y no toca el balance', async (type) => {
      const { acc, admin } = await buildLowFundsAccount(100);

      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: type, amount: 500, beneficiaryName: 'X',
      }, asUser(admin))).rejects.toMatchObject({
        status: 409, code: 'INSUFFICIENT_BALANCE',
      });

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(100); // intacto
    });

    it('ADJUSTMENT OUT con saldo insuficiente también bloquea (regla universal)', async () => {
      const { acc, admin } = await buildLowFundsAccount(100);

      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: 'ADJUSTMENT', direction: 'OUT', amount: 500,
      }, asUser(admin))).rejects.toMatchObject({
        status: 409, code: 'INSUFFICIENT_BALANCE',
      });

      const bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(100);
    });

    it('ADJUSTMENT IN siempre permitido (incluso con saldo 0)', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      const result = await cashAccountsService.registerMovement(acc.id, {
        movementType: 'ADJUSTMENT', direction: 'IN', amount: 999.99,
        description: 'corrección contable',
      }, asUser(admin));
      expect(result.current_balance).toBeCloseTo(999.99, 2);
    });
  });

  // ── IMP-3: cuenta inactiva bloquea movimientos ──────────────────────────
  describe('IMP-3: cuentas inactivas', () => {
    it('registerMovement sobre cuenta inactiva lanza 409 ACCOUNT_INACTIVE', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });

      await pool.query(`UPDATE cash_accounts SET is_active = FALSE WHERE id = $1`, [acc.id]);
      try {
        await expect(cashAccountsService.registerMovement(acc.id, {
          movementType: 'ADJUSTMENT', direction: 'IN', amount: 100,
        }, asUser(admin))).rejects.toMatchObject({
          status: 409, code: 'ACCOUNT_INACTIVE',
        });

        // Ni siquiera ADJUSTMENT IN pasa — la cuenta es la frontera, no la dirección.
        await expect(cashAccountsService.registerMovement(acc.id, {
          movementType: 'EXPENSE', amount: 50,
        }, asUser(admin))).rejects.toMatchObject({
          status: 409, code: 'ACCOUNT_INACTIVE',
        });
      } finally {
        await pool.query(`UPDATE cash_accounts SET is_active = TRUE WHERE id = $1`, [acc.id]);
      }
    });
  });

  // ── Validaciones del service ────────────────────────────────────────────
  describe('Validaciones de service', () => {
    it('ADJUSTMENT sin direction lanza 422 INVALID_DIRECTION', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: 'ADJUSTMENT', amount: 100,
      }, asUser(admin))).rejects.toMatchObject({
        status: 422, code: 'INVALID_DIRECTION',
      });
    });

    it('movement_type DROP_IN no se acepta desde el endpoint público', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: 'DROP_IN', amount: 100,
      }, asUser(admin))).rejects.toMatchObject({
        status: 422, code: 'INVALID_MOVEMENT_TYPE',
      });
    });

    it('IMP-6: SALARY_PAYMENT no se acepta desde el endpoint público (única vía: commissions.liquidate)', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: 'SALARY_PAYMENT', amount: 1000, beneficiaryName: 'X',
      }, asUser(admin))).rejects.toMatchObject({
        status: 422, code: 'INVALID_MOVEMENT_TYPE',
      });
    });

    it('amount <= 0 lanza 422 INVALID_AMOUNT', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await expect(cashAccountsService.registerMovement(acc.id, {
        movementType: 'EXPENSE', amount: 0,
      }, asUser(admin))).rejects.toMatchObject({
        status: 422, code: 'INVALID_AMOUNT',
      });
    });
  });

  // ── Audit balance ───────────────────────────────────────────────────────
  describe('Audit balance', () => {
    it('cached y computed coinciden inicialmente (drift=0)', async () => {
      const acc = await getGeneralCashAccount();
      const audit = await cashAccountsService.getAuditBalance(acc.id);
      expect(audit.cached).toBe(0);
      expect(audit.computed).toBe(0);
      expect(audit.drift).toBe(0);
    });

    it('cached y computed coinciden tras varios movimientos (drift=0)', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await cashAccountsService.registerMovement(acc.id, { movementType: 'ADJUSTMENT', direction: 'IN', amount: 1000 }, asUser(admin));
      await cashAccountsService.registerMovement(acc.id, { movementType: 'SUPPLIER_PAYMENT', amount: 300 }, asUser(admin));
      await cashAccountsService.registerMovement(acc.id, { movementType: 'EXPENSE', amount: 50 }, asUser(admin));
      await cashAccountsService.registerMovement(acc.id, { movementType: 'ADJUSTMENT', direction: 'IN', amount: 200 }, asUser(admin));

      const audit = await cashAccountsService.getAuditBalance(acc.id);
      expect(audit.cached).toBe(850);
      expect(audit.computed).toBe(850);
      expect(audit.drift).toBe(0);
    });

    it('detecta drift si current_balance se desincroniza del libro', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await cashAccountsService.registerMovement(acc.id, { movementType: 'ADJUSTMENT', direction: 'IN', amount: 500 }, asUser(admin));

      // Simulamos drift: escritura directa al cache sin pasar por el service.
      await pool.query(`UPDATE cash_accounts SET current_balance = current_balance + 100 WHERE id = $1`, [acc.id]);

      const audit = await cashAccountsService.getAuditBalance(acc.id);
      expect(audit.cached).toBe(600);
      expect(audit.computed).toBe(500);
      expect(audit.drift).toBe(100);
    });
  });

  // ── listMovements ───────────────────────────────────────────────────────
  describe('listMovements', () => {
    const seedMovements = async (acc, admin) => {
      await cashAccountsService.registerMovement(acc.id, { movementType: 'ADJUSTMENT', direction: 'IN', amount: 10000, description: 'seed' }, asUser(admin));
      await cashAccountsService.registerMovement(acc.id, { movementType: 'SUPPLIER_PAYMENT', amount: 1000, beneficiaryName: 'P1' }, asUser(admin));
      await cashAccountsService.registerMovement(acc.id, { movementType: 'SUPPLIER_PAYMENT', amount: 500,  beneficiaryName: 'P2' }, asUser(admin));
      // SALARY_PAYMENT no se acepta desde endpoint público (IMP-6). Lo
      // insertamos directo para mantener cobertura de filter por movement_type.
      await pool.query(
        `INSERT INTO cash_account_movements
           (cash_account_id, movement_type, direction, amount, description,
            beneficiary_name, created_by)
         VALUES ($1,'SALARY_PAYMENT','OUT',800,'simulación liquidación','Empl',$2)`,
        [acc.id, admin.id],
      );
      await pool.query(
        `UPDATE cash_accounts SET current_balance = current_balance - 800 WHERE id = $1`,
        [acc.id],
      );
      await cashAccountsService.registerMovement(acc.id, { movementType: 'EXPENSE',          amount: 200 }, asUser(admin));
    };

    it('sin filtros devuelve todos los movimientos paginados', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await seedMovements(acc, admin);

      const r = await cashAccountsService.listMovements(acc.id, { page: 1, pageSize: 10 });
      expect(r.items.length).toBe(5);
      expect(r.pagination).toMatchObject({ page: 1, page_size: 10, total: 5, total_pages: 1 });
    });

    it('filtra por movement_type', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await seedMovements(acc, admin);

      const r = await cashAccountsService.listMovements(acc.id, { movementType: 'SUPPLIER_PAYMENT' });
      expect(r.pagination.total).toBe(2);
      expect(r.items.every((m) => m.movement_type === 'SUPPLIER_PAYMENT')).toBe(true);
    });

    it('filtra por direction', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await seedMovements(acc, admin);

      const r = await cashAccountsService.listMovements(acc.id, { direction: 'IN' });
      expect(r.pagination.total).toBe(1); // solo el ADJUSTMENT IN seed
      expect(r.items[0].movement_type).toBe('ADJUSTMENT');
    });

    it('pagina correctamente (page=2)', async () => {
      const acc = await getGeneralCashAccount();
      const admin = await createUserFixture({ role: 'ADMIN' });
      await seedMovements(acc, admin);

      const r = await cashAccountsService.listMovements(acc.id, { page: 2, pageSize: 2 });
      expect(r.items.length).toBe(2);
      expect(r.pagination).toMatchObject({ page: 2, page_size: 2, total: 5, total_pages: 3 });
    });
  });

  // ── Integración cross-module: reverseDrop con/sin fondos ────────────────
  describe('Integración con reverseDrop (cash_session_drops)', () => {
    it('reverseDrop con fondos suficientes genera ADJUSTMENT OUT y deja balance en cero', async () => {
      const acc = await getGeneralCashAccount();
      const collector = await createUserFixture({ role: 'COLLECTOR' });
      const session = await cashSessionsService.open({ opening_amount: 0 }, asUser(collector));

      const drop = await cashSessionsService.addDrop(session.id, {
        amount: 1500, payment_method: 'CASH',
      }, asUser(collector));

      let bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(1500);

      await cashSessionsService.reverseDrop(session.id, drop.id,
        { reason: 'corrección' }, asUser(collector));

      bal = await cashAccountsService.getBalance(acc.id);
      expect(bal.current_balance).toBe(0);

      // 2 movimientos: DROP_IN + ADJUSTMENT OUT
      const list = await cashAccountsService.listMovements(acc.id, {});
      expect(list.pagination.total).toBe(2);
      const types = list.items.map((m) => `${m.movement_type}/${m.direction}`).sort();
      expect(types).toEqual(['ADJUSTMENT/OUT', 'DROP_IN/IN']);

      // El ADJUSTMENT OUT referencia al DROP_IN original.
      const adj = list.items.find((m) => m.movement_type === 'ADJUSTMENT');
      const dropIn = list.items.find((m) => m.movement_type === 'DROP_IN');
      expect(adj.reference_type).toBe('CASH_ACCOUNT_MOVEMENT');
      expect(adj.reference_id).toBe(dropIn.id);
    });

    it('reverseDrop con saldo insuficiente falla 409 y revierte toda la tx (drop sigue ACTIVE)', async () => {
      const acc = await getGeneralCashAccount();
      const collector = await createUserFixture({ role: 'COLLECTOR' });
      const admin     = await createUserFixture({ role: 'ADMIN' });
      const session   = await cashSessionsService.open({ opening_amount: 0 }, asUser(collector));

      const drop = await cashSessionsService.addDrop(session.id, {
        amount: 2000, payment_method: 'CASH',
      }, asUser(collector));

      // Admin gasta 1800 → balance Caja General = 200 (insuficiente para reverse de 2000)
      await cashAccountsService.registerMovement(acc.id, {
        movementType: 'SUPPLIER_PAYMENT', amount: 1800, beneficiaryName: 'P',
      }, asUser(admin));

      const balPre = await cashAccountsService.getBalance(acc.id);
      expect(balPre.current_balance).toBe(200);

      await expect(cashSessionsService.reverseDrop(session.id, drop.id,
        { reason: 'no debería pasar' }, asUser(collector)),
      ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_BALANCE' });

      // El drop sigue ACTIVE; balance intacto; no se creó ADJUSTMENT.
      const dropFresh = await cashSessionsQueries.findDropById(drop.id);
      expect(dropFresh.status).toBe('ACTIVE');

      const balPost = await cashAccountsService.getBalance(acc.id);
      expect(balPost.current_balance).toBe(200);

      const movs = await cashAccountsService.listMovements(acc.id, { movementType: 'ADJUSTMENT' });
      expect(movs.pagination.total).toBe(0);
    });
  });
});
