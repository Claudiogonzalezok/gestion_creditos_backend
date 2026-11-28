// #113 — reportes.getProductsReport
// El reporte de productos no debe multiplicar stock, ventas e ingresos por la
// cantidad de tasas del producto, ni las tasas por la cantidad de unidades/ventas.

const { pool, setupTestSuite } = require('./helpers/db');
const { createCreditFixture } = require('./helpers/fixtures');
const reportsQueries = require('../../src/modules/reports/reports.queries');

setupTestSuite();

let seq = 0;
const tag = () => `R113-${Date.now()}-${++seq}`;

/**
 * Crea un producto con 3 unidades disponibles y 3 vendidas (ingresos reales 6000)
 * y K tasas (la última inactiva cuando K > 1).
 * Una unidad vendida tiene además una venta previa en un crédito rechazado,
 * que no debe contar ni duplicar la unidad.
 */
const seedProduct = async (ratesCount) => {
  const p = await pool.query(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [
    `Producto ${tag()}`,
  ]);
  const productId = p.rows[0].id;
  const v = await pool.query(
    `INSERT INTO product_variants (product_id, current_price) VALUES ($1, 1000) RETURNING id`,
    [productId],
  );
  const variantId = v.rows[0].id;

  const addUnit = async (status) => {
    const u = await pool.query(
      `INSERT INTO product_units (variant_id, unit_code, status) VALUES ($1, $2, $3) RETURNING id`,
      [variantId, tag(), status],
    );
    return u.rows[0].id;
  };
  const sell = async (unitId, price, creditStatus = 'ACTIVE') => {
    const credit = await createCreditFixture({
      type: 'SALE',
      status: creditStatus,
      total_amount: price,
    });
    await pool.query(
      `INSERT INTO credit_products (credit_id, product_unit_id, historical_price) VALUES ($1, $2, $3)`,
      [credit.id, unitId, price],
    );
  };

  for (let i = 0; i < 3; i++) await addUnit('AVAILABLE');
  await sell(await addUnit('SOLD'), 1000);
  await sell(await addUnit('SOLD'), 3000, 'SETTLED');
  const resold = await addUnit('SOLD');
  await sell(resold, 999, 'REJECTED');
  await sell(resold, 2000);

  for (let i = 1; i <= ratesCount; i++) {
    const active = !(ratesCount > 1 && i === ratesCount);
    await pool.query(
      `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate, active)
       VALUES ($1, 'WEEKLY', $2, 0.1, $3)`,
      [productId, i, active],
    );
  }
  return productId;
};

const reportRow = async (productId, threshold) => {
  const rows = await reportsQueries.getProductsReport(threshold);
  return rows.find((r) => r.id === productId);
};

describe('#113 — getProductsReport con varias tasas', () => {
  it.each([0, 1, 4])('con %i tasas informa stock, ventas, ingresos y tasas reales', async (k) => {
    const productId = await seedProduct(k);
    const row = await reportRow(productId, 3);

    expect(row.available_count).toBe(3);
    expect(row.total_units_sold).toBe(3);
    expect(row.low_stock).toBe(true);
    expect(row.times_sold).toBe(3);
    expect(row.total_revenue).toBeCloseTo(6000, 2);
    expect(row.avg_selling_price).toBeCloseTo(2000, 2);
    expect(row.total_rates_count).toBe(k);
    expect(row.active_rates_count).toBe(k > 1 ? k - 1 : k);
    expect(row.min_price).toBeCloseTo(1000, 2);
    expect(row.max_price).toBeCloseTo(1000, 2);
  });

  it('calcula low_stock sobre el stock real y no sobre el inflado', async () => {
    const productId = await seedProduct(4);
    expect((await reportRow(productId, 2)).low_stock).toBe(false);
    expect((await reportRow(productId, 3)).low_stock).toBe(true);
  });

  it('un producto sin variantes informa ceros', async () => {
    const p = await pool.query(`INSERT INTO products (title) VALUES ($1) RETURNING id`, [
      `Producto ${tag()}`,
    ]);
    const row = await reportRow(p.rows[0].id, 5);
    expect(row).toMatchObject({
      available_count: 0,
      total_units_sold: 0,
      low_stock: true,
      times_sold: 0,
      total_revenue: 0,
      avg_selling_price: 0,
      active_rates_count: 0,
      total_rates_count: 0,
      min_price: 0,
      max_price: 0,
    });
  });
});
