// Bloque K — Reserva concurrente de product_units
// Verifica el helper transitionStatus y el patrón SELECT FOR UPDATE + guard
// SQL que blinda la transición AVAILABLE → RESERVED en credits.service contra
// races: dos requests para la misma unidad serializan y uno solo gana.

const { pool, setupTestSuite, withTestClient } = require('./helpers/db');
const puQueries = require('../../src/modules/productUnits/productUnits.queries');

setupTestSuite();

let unitCodeSeq = 0;
const nextUnitCode = () => `TEST-UNIT-${Date.now()}-${++unitCodeSeq}`;
let productTitleSeq = 0;
const nextProductTitle = () => `Producto Test ${Date.now()} ${++productTitleSeq}`;

/** Crea producto + variante + unidad AVAILABLE. Devuelve el unitId. */
const createAvailableUnit = async () => {
  const product = await pool.query(
    `INSERT INTO products (title) VALUES ($1) RETURNING id`,
    [nextProductTitle()],
  );
  const variant = await pool.query(
    `INSERT INTO product_variants (product_id, current_price) VALUES ($1, $2) RETURNING id`,
    [product.rows[0].id, 1000],
  );
  const unit = await pool.query(
    `INSERT INTO product_units (variant_id, unit_code) VALUES ($1, $2) RETURNING id, status`,
    [variant.rows[0].id, nextUnitCode()],
  );
  return unit.rows[0];
};

const readStatus = async (unitId) => {
  const r = await pool.query(`SELECT status FROM product_units WHERE id = $1`, [unitId]);
  return r.rows[0]?.status;
};

describe('K — Reserva concurrente de product_units', () => {
  describe('transitionStatus (guard SQL)', () => {
    it('AVAILABLE → RESERVED devuelve true y actualiza el status', async () => {
      const unit = await createAvailableUnit();
      const ok = await withTestClient((client) =>
        puQueries.transitionStatus(client, unit.id, 'AVAILABLE', 'RESERVED'),
      );
      expect(ok).toBe(true);
      expect(await readStatus(unit.id)).toBe('RESERVED');
    });

    it('si ya está RESERVED, AVAILABLE → RESERVED devuelve false y no toca la fila', async () => {
      const unit = await createAvailableUnit();
      await pool.query(`UPDATE product_units SET status = 'RESERVED' WHERE id = $1`, [unit.id]);

      const ok = await withTestClient((client) =>
        puQueries.transitionStatus(client, unit.id, 'AVAILABLE', 'RESERVED'),
      );
      expect(ok).toBe(false);
      expect(await readStatus(unit.id)).toBe('RESERVED');
    });

    it('si fue dada de baja (INACTIVE), AVAILABLE → RESERVED devuelve false', async () => {
      const unit = await createAvailableUnit();
      await pool.query(`UPDATE product_units SET status = 'INACTIVE' WHERE id = $1`, [unit.id]);

      const ok = await withTestClient((client) =>
        puQueries.transitionStatus(client, unit.id, 'AVAILABLE', 'RESERVED'),
      );
      expect(ok).toBe(false);
      expect(await readStatus(unit.id)).toBe('INACTIVE');
    });
  });

  describe('Concurrencia: SELECT FOR UPDATE + transitionStatus', () => {
    /**
     * Simula el patrón de credits.service: dentro de una transacción, SELECT
     * FOR UPDATE de la unidad, "trabajo" (sleep), y luego transitionStatus.
     * Dos racers concurrentes sobre la misma unidad: el FOR UPDATE bloquea al
     * segundo hasta el COMMIT del primero, y al desbloquearse el guard SQL
     * impide la segunda reserva.
     */
    const racer = async (unitId, workMs) => {
      return withTestClient(async (client) => {
        await client.query(
          `SELECT id, status FROM product_units WHERE id = $1 FOR UPDATE`,
          [unitId],
        );
        if (workMs > 0) await new Promise((r) => setTimeout(r, workMs));
        return puQueries.transitionStatus(client, unitId, 'AVAILABLE', 'RESERVED');
      });
    };

    it('dos requests sobre la misma unidad: uno gana, otro pierde', async () => {
      const unit = await createAvailableUnit();
      const [a, b] = await Promise.all([racer(unit.id, 80), racer(unit.id, 0)]);

      // Exactamente uno reservó (la fila quedó RESERVED una sola vez).
      const winners = [a, b].filter(Boolean).length;
      expect(winners).toBe(1);
      expect(await readStatus(unit.id)).toBe('RESERVED');
    });

    it('dos requests sobre unidades distintas: ambos ganan', async () => {
      const u1 = await createAvailableUnit();
      const u2 = await createAvailableUnit();
      const [a, b] = await Promise.all([racer(u1.id, 50), racer(u2.id, 50)]);

      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(await readStatus(u1.id)).toBe('RESERVED');
      expect(await readStatus(u2.id)).toBe('RESERVED');
    });
  });
});
