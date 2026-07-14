// Integración — frecuencia de pago DAILY (diaria).
//
// Verifica contra Postgres real que un crédito DIARIO:
//   · genera cuotas con vencimientos en días CORRIDOS (cada cuota +1 día
//     exacto respecto de la anterior), sin corrimiento por día hábil.
//   · al ser 7 cuotas, la ventana siempre incluye al menos un domingo: que
//     los saltos sigan siendo de exactamente 1 día demuestra que DAILY NO
//     aplica la regla de día hábil (días corridos, sin solapamiento).
//
// Cubre los dos puntos críticos del cálculo de fechas para DAILY:
// addFrequencyPeriods (rama +1 día) y la exención de
// applyBusinessDayRuleToDueDates.

const { pool, setupTestSuite } = require("./helpers/db");
const {
  createUserFixture,
  createCreditFixture,
} = require("./helpers/fixtures");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const creditsService = require("../../src/modules/credits/credits.service");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

// interest_rates es data de referencia: se limpia el combo puntual antes de
// insertar para no chocar con otros tests.
const ensureRate = async ({ frequency, installments, rate }) => {
  await pool.query(
    `DELETE FROM interest_rates WHERE payment_frequency=$1 AND installments_count=$2`,
    [frequency, installments],
  );
  await pool.query(
    `INSERT INTO interest_rates (payment_frequency, installments_count, min_amount, max_amount, rate, active)
     VALUES ($1, $2, 0, 999999999, $3, TRUE)`,
    [frequency, installments, rate],
  );
};

describe("Créditos — frecuencia DAILY (diaria)", () => {
  it("genera 7 cuotas con vencimientos en días corridos (+1 día exacto, sin corrimiento hábil)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    await ensureRate({ frequency: "DAILY", installments: 7, rate: 0.07 });
    const credit = await createCreditFixture({
      type: "LOAN",
      status: "PENDING_APPROVAL",
      total_amount: 35000,
      installments_count: 7,
      payment_frequency: "DAILY",
      approved_at: null,
    });
    await cashSessionsService.open({ opening_amount: 50000 }, asUser(admin));

    const approved = await creditsService.approve(credit.id, admin.id);
    expect(approved.status).toBe("ACTIVE");

    const { rows } = await pool.query(
      `SELECT installment_number, due_date::text AS due_date
       FROM installments
       WHERE credit_id = $1
       ORDER BY installment_number`,
      [credit.id],
    );

    expect(rows).toHaveLength(7);

    // Cada cuota vence exactamente 1 día después de la anterior. Sobre 7 días
    // consecutivos siempre cae un domingo: si se aplicara la regla de día hábil
    // habría un salto ≠ 1 o una fecha repetida. Que TODOS los saltos sean de 1
    // día prueba los días corridos.
    for (let i = 1; i < rows.length; i++) {
      const prev = new Date(`${rows[i - 1].due_date}T12:00:00`);
      const curr = new Date(`${rows[i].due_date}T12:00:00`);
      const diffDays = Math.round((curr - prev) / (24 * 60 * 60 * 1000));
      expect(diffDays).toBe(1);
    }
  });
});
