// #90 — GET /api/payments con created_from/created_to (fecha de registro,
// incluye pre-cargas PENDING). Compone con status, scoping de cobrador y paginación.

// uuid@13 es ESM-only y jest (CommonJS) no lo carga al importar app.js.
jest.mock('uuid', () => ({ v4: () => require('crypto').randomUUID() }));
jest.setTimeout(30000);

const request = require('supertest');
const app = require('../../src/app');
const { pool, setupTestSuite } = require('./helpers/db');
const { createUserFixture, createPendingPaymentFixture } = require('./helpers/fixtures');
const { generateInternalToken } = require('../../src/utils/jwt');

setupTestSuite();

const auth = (user) => ({ Authorization: `Bearer ${generateInternalToken(user)}` });

// Crea una pre-carga y fija su created_at (mediodía para evitar bordes de zona horaria).
const seed = async (createdDate, overrides = {}) => {
  const p = await createPendingPaymentFixture(overrides);
  await pool.query(`UPDATE payments SET created_at = $1::timestamp WHERE id = $2`, [
    `${createdDate} 12:00:00`,
    p.id,
  ]);
  return p;
};

let admin, collector, enero, marzo, marzoAjeno, marzoRechazado;
beforeEach(async () => {
  admin = await createUserFixture({ role: 'ADMIN' });
  collector = await createUserFixture({ role: 'COLLECTOR' });
  enero = await seed('2026-01-15', { collector_id: collector.id });
  marzo = await seed('2026-03-10', { collector_id: collector.id });
  marzoAjeno = await seed('2026-03-12');
  marzoRechazado = await seed('2026-03-20', { collector_id: collector.id, status: 'REJECTED' });
});

const ids = (res) => res.body.data.map((r) => r.id);

describe('GET /api/payments — created_from/created_to', () => {
  it('acota por created_at e incluye PENDING (rango inclusivo)', async () => {
    const res = await request(app)
      .get('/api/payments?created_from=2026-03-10&created_to=2026-03-20')
      .set(auth(admin));
    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([marzo.id, marzoAjeno.id, marzoRechazado.id].sort());
    expect(ids(res)).not.toContain(enero.id);
  });

  it('compone con status', async () => {
    const res = await request(app)
      .get('/api/payments?created_from=2026-03-01&status=PENDING')
      .set(auth(admin));
    expect(ids(res).sort()).toEqual([marzo.id, marzoAjeno.id].sort());
  });

  it('cobrador solo ve los suyos aunque filtre por fecha', async () => {
    const res = await request(app)
      .get('/api/payments?created_from=2026-03-01&created_to=2026-03-31')
      .set(auth(collector));
    expect(res.status).toBe(200);
    expect(ids(res).sort()).toEqual([marzo.id, marzoRechazado.id].sort());
  });

  it('compone con paginación (total refleja el filtro)', async () => {
    const res = await request(app)
      .get('/api/payments?created_from=2026-03-01&limit=2&page=1')
      .set(auth(admin));
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(3);
    // Orden created_at DESC: la más reciente primero.
    expect(res.body.data[0].id).toBe(marzoRechazado.id);
  });

  it('sin filtro de fecha la respuesta no cambia', async () => {
    const res = await request(app).get('/api/payments').set(auth(admin));
    expect(res.body.data).toHaveLength(4);
  });

  it.each([
    ['created_from=2026-13-01'],
    ['created_to=ayer'],
    ['created_from=2026-03-20&created_to=2026-03-10'],
  ])('rechaza fechas inválidas: %s → 400', async (qs) => {
    const res = await request(app).get(`/api/payments?${qs}`).set(auth(admin));
    expect(res.status).toBe(400);
  });
});
