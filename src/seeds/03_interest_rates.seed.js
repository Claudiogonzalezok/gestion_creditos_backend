// Semilla 03 — Tasas de interés (coeficientes reales del negocio)
//
// Estructura de la tabla interest_rates:
//   - min_amount / max_amount: rango de monto del préstamo
//   - installments_count: cantidad de cuotas
//   - payment_frequency: WEEKLY | BIWEEKLY | MONTHLY
//   - rate: coeficiente multiplicador (ej: 1.32)
//
// Lógica de búsqueda en interestRates.queries.js → findActiveRate():
//   WHERE $amount >= min_amount AND ($amount <= max_amount OR max_amount IS NULL)
//
// Fórmula de cálculo en creditCalculator.js → getInstallmentAmount():
//   totalConInteres = monto × (1 + rate)
//   cuota = Math.ceil((totalConInteres / cuotas) / 1000) × 1000  ← redondea al millar

const pool = require('../config/db');

const rates = [
  // ── Hasta $100.000 ──────────────────────────────────────────
  { min_amount:      0, max_amount: 100000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.32 },
  { min_amount:      0, max_amount: 100000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.54 },
  { min_amount:      0, max_amount: 100000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.89 },

  // ── $100.001 a $150.000 ──────────────────────────────────────
  { min_amount: 100001, max_amount: 150000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.30 },
  { min_amount: 100001, max_amount: 150000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.57333 },
  { min_amount: 100001, max_amount: 150000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.85 },

  // ── $150.001 a $200.000 ──────────────────────────────────────
  { min_amount: 150001, max_amount: 200000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.28 },
  { min_amount: 150001, max_amount: 200000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.55 },
  { min_amount: 150001, max_amount: 200000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.80 },
  { min_amount: 150001, max_amount: 200000, installments_count: 4, payment_frequency: 'MONTHLY', rate: 0.96 },

  // ── $200.001 a $300.000 ──────────────────────────────────────
  { min_amount: 200001, max_amount: 300000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.25 },
  { min_amount: 200001, max_amount: 300000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.48 },
  { min_amount: 200001, max_amount: 300000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.80 },
  { min_amount: 200001, max_amount: 300000, installments_count: 4, payment_frequency: 'MONTHLY', rate: 0.96 },

  // ── $300.001 a $400.000 ──────────────────────────────────────
  { min_amount: 300001, max_amount: 400000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.24 },
  { min_amount: 300001, max_amount: 400000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.47 },
  { min_amount: 300001, max_amount: 400000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.80 },
  { min_amount: 300001, max_amount: 400000, installments_count: 4, payment_frequency: 'MONTHLY', rate: 0.95 },

  // ── $400.001 a $500.000 ──────────────────────────────────────
  { min_amount: 400001, max_amount: 500000, installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.22 },
  { min_amount: 400001, max_amount: 500000, installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.44 },
  { min_amount: 400001, max_amount: 500000, installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.68 },
  { min_amount: 400001, max_amount: 500000, installments_count: 4, payment_frequency: 'MONTHLY', rate: 0.88 },

  // ── Más de $500.000 (sin límite superior) ────────────────────
  { min_amount: 500001, max_amount: null,   installments_count: 1, payment_frequency: 'MONTHLY', rate: 0.22 },
  { min_amount: 500001, max_amount: null,   installments_count: 2, payment_frequency: 'MONTHLY', rate: 0.44 },
  { min_amount: 500001, max_amount: null,   installments_count: 3, payment_frequency: 'MONTHLY', rate: 0.68 },
  { min_amount: 500001, max_amount: null,   installments_count: 4, payment_frequency: 'MONTHLY', rate: 0.88 },
];

const seed = async () => {
  console.log('🌱  [3/3] Cargando tasas de interés...');

  // Limpiar y recargar para evitar duplicados
  await pool.query(`DELETE FROM interest_rates`);

  for (const r of rates) {
    await pool.query(
      `INSERT INTO interest_rates
         (installments_count, payment_frequency, rate, active, min_amount, max_amount)
       VALUES ($1, $2, $3, TRUE, $4, $5)`,
      [r.installments_count, r.payment_frequency, r.rate, r.min_amount, r.max_amount]
    );
  }

  console.log(`   ✅  ${rates.length} tasas cargadas.`);
  console.log('');
  console.log('   Coeficientes por rango (frecuencia mensual):');
  console.log('   ┌─────────────────────┬──────┬──────┬──────┬──────┐');
  console.log('   │ Rango               │ 1c   │ 2c   │ 3c   │ 4c   │');
  console.log('   ├─────────────────────┼──────┼──────┼──────┼──────┤');
  console.log('   │ Hasta $100.000      │ 1.32 │ 1.54 │ 1.89 │  --  │');
  console.log('   │ $100.001-$150.000   │ 1.30 │ 1.57 │ 1.85 │  --  │');
  console.log('   │ $150.001-$200.000   │ 1.28 │ 1.55 │ 1.80 │ 1.96 │');
  console.log('   │ $200.001-$300.000   │ 1.25 │ 1.48 │ 1.80 │ 1.96 │');
  console.log('   │ $300.001-$400.000   │ 1.24 │ 1.47 │ 1.80 │ 1.95 │');
  console.log('   │ $400.001-$500.000   │ 1.22 │ 1.44 │ 1.68 │ 1.88 │');
  console.log('   │ Más de $500.000     │ 1.22 │ 1.44 │ 1.68 │ 1.88 │');
  console.log('   └─────────────────────┴──────┴──────┴──────┴──────┘');
  console.log('   Nota: rate = coeficiente - 1 (ej: 1.32 → rate 0.32)');
};

module.exports = seed;
