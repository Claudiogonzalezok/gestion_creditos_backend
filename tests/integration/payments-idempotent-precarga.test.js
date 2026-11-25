// P08 / issue #28 — pre-carga idempotente y con lock.
//
// Un doble toque o un reintento de red del cobrador no debe crear dos
// pre-cargas PENDING por el mismo cobro. Defensas verificadas:
//   · `client_request_id` (clave de idempotencia por cobrador, índice UNIQUE
//     parcial en payments): reintentar devuelve la pre-carga existente.
//   · Lock del crédito (SELECT ... FOR UPDATE) dentro de la transacción de
//     create: dos requests concurrentes recalculan el disponible en serie.

const { pool, setupTestSuite } = require('./helpers/db');
const {
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
} = require('./helpers/fixtures');
const { today } = require('./helpers/dates');
const paymentsService = require('../../src/modules/payments/payments.service');

setupTestSuite();

const KEY_A = '7f1c2e9a-3b4d-4c5e-8f6a-1b2c3d4e5f60';
const KEY_B = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

const countPayments = async (installmentId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM payments WHERE installment_id = $1`,
    [installmentId],
  );
  return r.rows[0].n;
};

const body = (installmentId, extra = {}) => ({
  installment_id: installmentId,
  amount_received: 1000,
  payment_method: 'CASH',
  ...extra,
});

const setup = async () => {
  const collector = await createUserFixture({ role: 'COLLECTOR' });
  const inst = await createInstallmentFixture({
    due_date: today(),
    original_amount: 1000,
    amount_paid: 0,
    status: 'PENDING',
  });
  return { collector, inst, user: { id: collector.id, role: collector.role } };
};

describe('P08 — pre-carga idempotente (client_request_id)', () => {
  it('mismo client_request_id dos veces → una sola pre-carga y el replay devuelve la existente', async () => {
    const { inst, user } = await setup();

    const first = await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);
    const second = await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);

    expect(await countPayments(inst.id)).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.idempotent_replay).toBe(true);
    expect(first.idempotent_replay).toBeUndefined();
    expect(first.client_request_id).toBe(KEY_A);
  });

  it('el replay no repite side-effects: no notifica de nuevo a los admins', async () => {
    await createUserFixture({ role: 'ADMIN' });
    const { inst, user } = await setup();
    const countNotifs = async () =>
      (await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n;

    await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);
    const afterFirst = await countNotifs();
    await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);

    expect(afterFirst).toBeGreaterThan(0);
    expect(await countNotifs()).toBe(afterFirst);
  });

  it('replay con installment_id y client_request_id en mayúsculas → mismo cobro (200 replay, no 409)', async () => {
    const { inst, user } = await setup();

    const first = await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);
    const again = await paymentsService.create(
      body(inst.id.toUpperCase(), { client_request_id: KEY_A.toUpperCase() }),
      user,
    );

    expect(again.id).toBe(first.id);
    expect(again.idempotent_replay).toBe(true);
    expect(await countPayments(inst.id)).toBe(1);
  });

  it('misma clave con otro generation_type → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { inst, user } = await setup();

    await paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user);
    await expect(
      paymentsService.create(body(inst.id, { generation_type: 'RENEWAL', client_request_id: KEY_A }), user),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await countPayments(inst.id)).toBe(1);
  });

  it('dos requests concurrentes con el mismo client_request_id → una sola pre-carga', async () => {
    const { inst, user } = await setup();

    const results = await Promise.allSettled([
      paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user),
      paymentsService.create(body(inst.id, { client_request_id: KEY_A }), user),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(results[0].value.id).toBe(results[1].value.id);
    expect(await countPayments(inst.id)).toBe(1);
  });

  it('client_request_id distintos → dos pre-cargas (si el saldo alcanza)', async () => {
    const { inst, user } = await setup();
    const half = { amount_received: 500, next_visit_date: today() };

    await paymentsService.create(body(inst.id, { ...half, client_request_id: KEY_A }), user);
    await paymentsService.create(body(inst.id, { ...half, client_request_id: KEY_B }), user);

    expect(await countPayments(inst.id)).toBe(2);
  });

  it('reusar el client_request_id con otro monto → 409 IDEMPOTENCY_KEY_REUSED, sin crear', async () => {
    const { inst, user } = await setup();
    const half = { amount_received: 500, next_visit_date: today() };

    await paymentsService.create(body(inst.id, { ...half, client_request_id: KEY_A }), user);
    await expect(
      paymentsService.create(body(inst.id, { amount_received: 400, next_visit_date: today(), client_request_id: KEY_A }), user),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });

    expect(await countPayments(inst.id)).toBe(1);
  });

  it('el mismo client_request_id de OTRO cobrador no colisiona (alcance por cobrador)', async () => {
    const { inst, user } = await setup();
    const other = await createUserFixture({ role: 'COLLECTOR' });
    const half = { amount_received: 500, next_visit_date: today() };

    await paymentsService.create(body(inst.id, { ...half, client_request_id: KEY_A }), user);
    await paymentsService.create(body(inst.id, { ...half, client_request_id: KEY_A }), { id: other.id, role: other.role });

    expect(await countPayments(inst.id)).toBe(2);
  });

  it('misma clave en vuelo sobre OTRO crédito (el lock no serializa) → el índice UNIQUE la frena: 409, una sola fila', async () => {
    const { inst, collector, user } = await setup();
    const credit2 = await createCreditFixture();
    const inst2 = await createInstallmentFixture({
      credit_id: credit2.id,
      due_date: today(),
      original_amount: 1000,
      amount_paid: 0,
      status: 'PENDING',
    });

    // Transacción "original" con la clave, todavía sin confirmar: la segunda
    // request no la ve (READ COMMITTED) y solo el índice puede frenarla.
    const tx = await pool.connect();
    let pending;
    try {
      await tx.query('BEGIN');
      await tx.query(
        `INSERT INTO payments (installment_id, collector_id, amount_received, amount_cash, payment_method, client_request_id)
         VALUES ($1, $2, 1000, 1000, 'CASH', $3)`,
        [inst.id, collector.id, KEY_A],
      );
      pending = paymentsService
        .create(body(inst2.id, { client_request_id: KEY_A }), user)
        .then((v) => ({ status: 'fulfilled', value: v }), (e) => ({ status: 'rejected', reason: e }));
      await new Promise((r) => setTimeout(r, 300));
      await tx.query('COMMIT');
    } finally {
      tx.release();
    }

    const result = await pending;
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await countPayments(inst2.id)).toBe(0);
    expect(await countPayments(inst.id)).toBe(1);
  });

  it('sin client_request_id se preserva el comportamiento anterior (dos pre-cargas parciales secuenciales)', async () => {
    const { inst, user } = await setup();
    const half = { amount_received: 500, next_visit_date: today() };

    const a = await paymentsService.create(body(inst.id, half), user);
    const b = await paymentsService.create(body(inst.id, half), user);

    expect(a.id).not.toBe(b.id);
    expect(a.client_request_id).toBeNull();
    expect(await countPayments(inst.id)).toBe(2);
    // Saldo ya comprometido: una tercera se rechaza como antes.
    await expect(paymentsService.create(body(inst.id, half), user))
      .rejects.toMatchObject({ status: 409 });
  });
});

describe('P08 — lock contra pre-cargas concurrentes sin clave', () => {
  // Calienta el pool para que las requests no se serialicen por accidente
  // esperando la apertura de conexiones (eso escondería la carrera).
  const warmPool = () =>
    Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.02)')));

  it('dos create concurrentes por el total de la cuota → una sola pre-carga, la otra 409/422', async () => {
    const rounds = [];
    for (let i = 0; i < 4; i += 1) rounds.push(await setup());
    await warmPool();

    const results = await Promise.all(
      rounds.map(({ inst, user }) =>
        Promise.allSettled([
          paymentsService.create(body(inst.id), user),
          paymentsService.create(body(inst.id), user),
        ]),
      ),
    );

    for (let i = 0; i < rounds.length; i += 1) {
      const fulfilled = results[i].filter((r) => r.status === 'fulfilled');
      const rejected = results[i].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect([409, 422]).toContain(rejected[0].reason.status);
      expect(await countPayments(rounds[i].inst.id)).toBe(1);
    }
  });
});
