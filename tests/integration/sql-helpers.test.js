// Bloque E — utils/installmentSql.js
// Verifica los helpers SQL ejecutados contra Postgres real:
//   · REAL_REMAINING_BALANCE  → (amount_due - amount_paid)
//   · REMAINING_CAPITAL       → original - max(paid - penalty, 0), >= 0
//   · IS_OVERDUE_DERIVED      → composite boolean: vencida + saldo + no terminal
//
// Estos helpers se interpolan en queries productivas (reports, customers,
// portal). Si su semántica cambia accidentalmente, todas esas queries lo
// reflejan — por eso los testeamos con SQL real.

const { pool, setupTestSuite } = require('./helpers/db');
const { createInstallmentFixture } = require('./helpers/fixtures');
const { today, daysAgo, daysFromNow } = require('./helpers/dates');
const {
  REAL_REMAINING_BALANCE,
  REMAINING_CAPITAL,
  IS_OVERDUE_DERIVED,
} = require('../../src/utils/installmentSql');

setupTestSuite();

const GRACE = 3;

// Helper local: lee escalares para una cuota usando los snippets.
const readHelpers = async (installmentId, graceDays = GRACE) => {
  const r = await pool.query(
    `SELECT
       ${REAL_REMAINING_BALANCE('i')}::float8        AS saldo,
       ${REMAINING_CAPITAL('i')}::float8             AS capital_pendiente,
       ${IS_OVERDUE_DERIVED('i', '$2')}              AS is_overdue
     FROM installments i
     WHERE i.id = $1`,
    [installmentId, graceDays]
  );
  return r.rows[0];
};

describe('E — REAL_REMAINING_BALANCE', () => {
  it('devuelve amount_due - amount_paid', async () => {
    const inst = await createInstallmentFixture({
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     300,
    });
    const { saldo } = await readHelpers(inst.id);
    expect(saldo).toBeCloseTo(800, 2);
  });

  it('cuota sin pagos: saldo = amount_due', async () => {
    const inst = await createInstallmentFixture({
      original_amount: 1500,
    });
    const { saldo } = await readHelpers(inst.id);
    expect(saldo).toBeCloseTo(1500, 2);
  });

  it('cuota totalmente pagada: saldo = 0', async () => {
    const inst = await createInstallmentFixture({
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });
    const { saldo } = await readHelpers(inst.id);
    expect(saldo).toBeCloseTo(0, 2);
  });
});

describe('E — REMAINING_CAPITAL', () => {
  it('paid > penalty: capital pendiente = original - (paid - penalty)', async () => {
    // original=1000, penalty=100, paid=300 → paid_capital = 300 - 100 = 200
    // capital_pendiente = 1000 - 200 = 800
    const inst = await createInstallmentFixture({
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     300,
    });
    const { capital_pendiente } = await readHelpers(inst.id);
    expect(capital_pendiente).toBeCloseTo(800, 2);
  });

  it('paid < penalty: capital queda intacto', async () => {
    // original=1000, penalty=300, paid=100 → paid_capital = max(100-300, 0) = 0
    // capital_pendiente = 1000 - 0 = 1000
    const inst = await createInstallmentFixture({
      original_amount: 1000,
      penalty_amount:  300,
      amount_due:      1300,
      amount_paid:     100,
    });
    const { capital_pendiente } = await readHelpers(inst.id);
    expect(capital_pendiente).toBeCloseTo(1000, 2);
  });

  it('paid cubre original + penalty: capital pendiente = 0', async () => {
    const inst = await createInstallmentFixture({
      original_amount: 1000,
      penalty_amount:  100,
      amount_due:      1100,
      amount_paid:     1100,
      status:          'PAID',
    });
    const { capital_pendiente } = await readHelpers(inst.id);
    expect(capital_pendiente).toBeCloseTo(0, 2);
  });

  // El GREATEST(..., 0) defensivo del helper REMAINING_CAPITAL solo importa
  // si amount_paid > amount_due (overpay). La DB lo bloquea con
  // CHECK (amount_paid <= amount_due) — el escenario es inalcanzable, así
  // que el GREATEST queda como defensa silenciosa sin escenario testeable.
});

describe('E — IS_OVERDUE_DERIVED', () => {
  it('cuota PENDING vencida hace 10 días con saldo → TRUE', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      status:          'PENDING',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(true);
  });

  it('cuota vencida hace 2 días con grace=3 → FALSE (dentro de gracia)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(2),
      original_amount: 1000,
      status:          'PENDING',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(false);
  });

  it('cuota PAID nunca es overdue, aunque due_date sea pasado', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(20),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'PAID',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(false);
  });

  it('cuota REFINANCED nunca es overdue', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(20),
      original_amount: 1000,
      status:          'REFINANCED',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(false);
  });

  it('cuota futura (due_date adelantado) → FALSE', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysFromNow(5),
      original_amount: 1000,
      status:          'PENDING',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(false);
  });

  it('cuota OVERDUE pero sin saldo (paid = amount_due) → FALSE', async () => {
    // Edge: estado colgado donde status=OVERDUE pero saldo=0.
    // El derivado defiende contra esto: si no hay saldo, no es overdue.
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     1000,
      status:          'OVERDUE',   // estado inconsistente intencional
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(false);
  });

  it('grace_days = 0: cuota vencida ayer → TRUE inmediatamente', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(1),
      original_amount: 1000,
      status:          'PENDING',
    });
    const { is_overdue } = await readHelpers(inst.id, 0);
    expect(is_overdue).toBe(true);
  });

  it('cuota vencida hoy con cualquier grace → FALSE (due_date < CURRENT_DATE es estricto)', async () => {
    const inst = await createInstallmentFixture({
      due_date:        today(),
      original_amount: 1000,
      status:          'PENDING',
    });
    const { is_overdue } = await readHelpers(inst.id, 0);
    expect(is_overdue).toBe(false);
  });

  it('cuota PARTIAL vencida con saldo restante → TRUE', async () => {
    const inst = await createInstallmentFixture({
      due_date:        daysAgo(10),
      original_amount: 1000,
      amount_paid:     300,
      status:          'PARTIAL',
    });
    const { is_overdue } = await readHelpers(inst.id);
    expect(is_overdue).toBe(true);
  });
});
