// P34 (#51) — Altas masivas atómicas y catálogos consistentes.

const { pool, setupTestSuite } = require('./helpers/db');
const variantQueries = require('../../src/modules/productVariants/productVariants.queries');
const variantService = require('../../src/modules/productVariants/productVariants.service');
const rateService = require('../../src/modules/interestRates/interestRates.service');
const unitQueries = require('../../src/modules/productUnits/productUnits.queries');
const productRatesQueries = require('../../src/modules/productRates/productRates.queries');
const productService = require('../../src/modules/products/products.service');

setupTestSuite();

let seq = 0;
const createProduct = async () => {
  const r = await pool.query(
    `INSERT INTO products (title) VALUES ($1) RETURNING id`,
    [`Producto P34 ${Date.now()} ${++seq}`],
  );
  return r.rows[0].id;
};

const countVariants = async (productId) => {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1`,
    [productId],
  );
  return r.rows[0].n;
};

describe('createBulk de variantes — todo o nada', () => {
  afterEach(() => jest.restoreAllMocks());

  it('si falla la última fila no queda ninguna variante ni unidad creada', async () => {
    const productId = await createProduct();
    const original = variantQueries.createWithClient;
    let calls = 0;
    jest.spyOn(variantQueries, 'createWithClient').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) throw new Error('fallo simulado en la fila 3');
      return original(...args);
    });

    await expect(variantService.createBulk({
      product_id: productId,
      rows: [
        { color: 'Rojo', current_price: 100, initial_units: 2 },
        { color: 'Azul', current_price: 100, initial_units: 1 },
        { color: 'Verde', current_price: 100, initial_units: 1 },
      ],
    })).rejects.toThrow('fallo simulado');

    expect(await countVariants(productId)).toBe(0);
    const units = await pool.query(
      `SELECT COUNT(*)::int AS n FROM product_units pu
       JOIN product_variants pv ON pv.id = pu.variant_id
       WHERE pv.product_id = $1`,
      [productId],
    );
    expect(units.rows[0].n).toBe(0);
  });

  it('alta masiva válida crea todas las variantes', async () => {
    const productId = await createProduct();
    const res = await variantService.createBulk({
      product_id: productId,
      rows: [{ color: 'Rojo', current_price: 100 }, { color: 'Azul', current_price: 100 }],
    });
    expect(res.created).toHaveLength(2);
    expect(await countVariants(productId)).toBe(2);
  });

  it('alta individual de variante sigue funcionando', async () => {
    const productId = await createProduct();
    await variantService.create({ product_id: productId, color: 'Negro', current_price: 50 });
    expect(await countVariants(productId)).toBe(1);
  });
});

describe('interestRates — reactivar sin solaparse', () => {
  // Limpieza de datos propios del test para que la suite sea re-ejecutable
  beforeEach(async () => {
    await pool.query(`DELETE FROM interest_rates WHERE installments_count IN (77, 78)`);
  });

  it('reactivar una tasa que se solapa con otra activa devuelve 409 y no la activa', async () => {
    const old = await rateService.create({
      payment_frequency: 'WEEKLY', installments_count: 77, min_amount: 0, max_amount: 1000, rate: 10,
    });
    await rateService.deactivate(old.id);
    await rateService.create({
      payment_frequency: 'WEEKLY', installments_count: 77, min_amount: 500, max_amount: 2000, rate: 20,
    });

    await expect(rateService.create({
      payment_frequency: 'WEEKLY', installments_count: 77, min_amount: 0, max_amount: 1000, rate: 15,
    })).rejects.toMatchObject({ status: 409 });

    const r = await pool.query(
      `SELECT active, rate::float8 AS rate FROM interest_rates WHERE id = $1`,
      [old.id],
    );
    expect(r.rows[0]).toEqual({ active: false, rate: 10 });
  });

  it('reactivar sin solapamiento sigue funcionando', async () => {
    const old = await rateService.create({
      payment_frequency: 'WEEKLY', installments_count: 78, min_amount: 0, max_amount: 1000, rate: 10,
    });
    await rateService.deactivate(old.id);
    const again = await rateService.create({
      payment_frequency: 'WEEKLY', installments_count: 78, min_amount: 0, max_amount: 1000, rate: 12,
    });
    expect(again.id).toBe(old.id);
    expect(again.active).toBe(true);
  });
});

describe('productRates — caché tras renombrar producto', () => {
  it('el listado de tasas muestra el nombre nuevo inmediatamente después de renombrar', async () => {
    const productId = await createProduct();
    await pool.query(
      `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate)
       VALUES ($1, 'WEEKLY', 10, 0.1)`,
      [productId],
    );
    const before = await productRatesQueries.findAll(productId);
    expect(before[0].product_name).toMatch(/^Producto P34/);

    const newTitle = `Renombrado P34 ${Date.now()}`;
    await productService.update(productId, { title: newTitle });

    const after = await productRatesQueries.findAll(productId);
    expect(after[0].product_name).toBe(newTitle);
  });
});

describe('productUnits — limpiar notes', () => {
  it('notes vacío o null limpia la nota; omitirla la conserva', async () => {
    const productId = await createProduct();
    const v = await pool.query(
      `INSERT INTO product_variants (product_id, current_price) VALUES ($1, 10) RETURNING id`,
      [productId],
    );
    const u = await pool.query(
      `INSERT INTO product_units (variant_id, unit_code, notes) VALUES ($1, $2, 'nota') RETURNING id`,
      [v.rows[0].id, `P34-${Date.now()}`],
    );
    const id = u.rows[0].id;

    expect((await unitQueries.update(id, { unitCode: undefined })).notes).toBe('nota');
    expect((await unitQueries.update(id, { notes: '' })).notes).toBeNull();
    await pool.query(`UPDATE product_units SET notes = 'otra' WHERE id = $1`, [id]);
    expect((await unitQueries.update(id, { notes: null })).notes).toBeNull();
  });
});
