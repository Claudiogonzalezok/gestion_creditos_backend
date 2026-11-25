const pool = require("../../config/db");
const { CTE_LATEST_NEXT_VISIT } = require("../collections/collections.queries");

/**
 * Lista créditos con filtros opcionales, incluyendo datos del cliente y creador.
 * @param {object} filtros - status, type, customer_id, created_by (todos opcionales).
 * @returns {Promise<object[]>} Filas de créditos ordenadas por fecha de creación descendente.
 */
const findAll = async ({ status, type, customer_id, created_by } = {}) => {
  let q = `
    SELECT c.id, c.type, c.payment_condition, c.total_amount::float8, c.installments_count::int, c.payment_frequency,
           c.interest_rate::float8, c.status, c.created_at, c.approved_at,
           -- Tasa efectiva para listados: LOAN la tiene en credits.interest_rate;
           -- en SALE financiada queda NULL ahí y se congela por producto en
           -- credit_products.historical_rate (SALE = 1 producto → MAX representa el valor).
           -- Contado y operaciones sin aprobar quedan NULL (no tienen tasa aún).
           COALESCE(
             c.interest_rate,
             (SELECT MAX(cp.historical_rate) FROM credit_products cp WHERE cp.credit_id = c.id)
           )::float8 AS effective_rate,
           -- Total a devolver = plan contractual (suma de original_amount, sin
           -- punitorios), excluyendo cuotas anuladas por cambio de plan. Si la
           -- operación no tiene cuotas (pendiente de aprobación) queda NULL → el
           -- front muestra "—".
           (SELECT SUM(i.original_amount)
              FROM installments i
             WHERE i.credit_id = c.id
               AND i.status <> 'PLAN_CHANGE_CANCELLED')::float8 AS total_to_return,
           cu.id AS customer_id, cu.full_name AS customer_name, cu.dni AS customer_dni,
           u.id   AS created_by_id,  u.full_name   AS created_by_name,
           col.id AS collector_id,   col.full_name AS collector_name
    FROM credits c
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN users u   ON u.id   = c.created_by
    LEFT JOIN users col ON col.id = cu.assigned_collector_id
    WHERE 1=1`;
  const params = [];
  if (status) {
    params.push(status);
    q += ` AND c.status = $${params.length}`;
  }
  if (type) {
    params.push(type);
    q += ` AND c.type = $${params.length}`;
  }
  if (customer_id) {
    params.push(customer_id);
    q += ` AND c.customer_id = $${params.length}`;
  }
  if (created_by) {
    params.push(created_by);
    q += ` AND c.created_by = $${params.length}`;
  }
  q += ` ORDER BY c.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

/**
 * Busca un crédito por ID con su detalle completo y cronograma asociado.
 * Para SALE también trae las unidades de producto con precio y tasa histórica congelados.
 * Incluye original_due_date en cada cuota para auditar corrimientos por pagos adelantados.
 * @param {string} id - ID del crédito.
 * @returns {Promise<object|null>} Crédito completo o null si no existe.
 */
const findById = async (id) => {
  const r = await pool.query(
    `SELECT c.id, c.type, c.payment_condition, c.total_amount::float8, c.down_payment::float8,
            c.down_payment_method, c.down_payment_cash::float8, c.down_payment_transfer::float8,
            c.down_payment_transfer_reference,
            c.prepaid_installments::int, c.prepaid_installments_method,
            c.prepaid_installments_cash::float8, c.prepaid_installments_transfer::float8,
            c.prepaid_installments_transfer_reference,
            c.installments_count::int, c.payment_frequency,
            -- to_char evita que node-postgres devuelva la fecha como Date en
            -- midnight UTC, que en TZ AR (GMT-3) cae al dia anterior al hacer
            -- setHours local. Como string YYYY-MM-DD el parseLocalDateInput
            -- reconstruye la fecha local sin sesgo.
            to_char(c.first_payment_date, 'YYYY-MM-DD') AS first_payment_date,
            c.interest_rate::float8, c.status, c.rejection_reason, c.notes, c.created_by,
            c.created_at, c.approved_at, c.approved_by,
            c.settled_at, c.settlement_amount::float8, c.settlement_type,
            c.refinanced_from_credit_id,
            cu.id AS customer_id, cu.full_name AS customer_name, cu.dni AS customer_dni,
            cu.phone AS customer_phone,
            u.id AS created_by_id, u.full_name AS created_by_name
     FROM credits c
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1`,
    [id],
  );
  if (!r.rows[0]) return null;
  const credit = r.rows[0];

  if (credit.type === "SALE") {
    const units = await pool.query(
      `SELECT cp.id, cp.historical_price::float8, cp.historical_rate::float8,
              pu.id   AS unit_id,   pu.unit_code, pu.status AS unit_status,
              pv.id   AS variant_id, pv.color, pv.size, pv.capacity,
              p.id    AS product_id, p.title AS product_name
       FROM credit_products cp
       JOIN product_units    pu ON pu.id  = cp.product_unit_id
       JOIN product_variants pv ON pv.id  = pu.variant_id
       JOIN products         p  ON p.id   = pv.product_id
       WHERE cp.credit_id = $1
       ORDER BY p.title, pv.color NULLS FIRST, pu.unit_code`,
      [id],
    );
    credit.units = units.rows;
  }

  // La fecha de cobro NO se almacena en installments: se DERIVA del último pago
  // aprobado de la cuota (única fuente de verdad = payments.approved_at). El
  // LEFT JOIN LATERAL resuelve fecha, origen (generation_type) y forma de pago en
  // UNA sola query (sin N+1 ni SELECT por cuota).
  // Próxima visita: se DERIVA de la agenda vigente (última gestión con fecha
  // futura) reutilizando el CTE latest_next_visit de collections, única fuente
  // de verdad. sched.full_name es quien la programó (admin o cobrador). Se usa
  // to_char para devolver la fecha como 'YYYY-MM-DD' sin sesgo de zona horaria.
  const inst = await pool.query(
    `WITH ${CTE_LATEST_NEXT_VISIT}
     SELECT i.id, i.installment_number, i.due_date, i.original_due_date,
            i.amount_due::float8, i.amount_paid::float8, i.penalty_amount::float8, i.status,
            lp.approved_at  AS paid_at,
            lp.generation_type,
            lp.payment_method AS paid_method,
            cu.full_name AS paid_by_name,
            to_char(lnv.next_visit_date, 'YYYY-MM-DD') AS next_visit_date,
            sched.full_name AS next_visit_scheduled_by_name
     FROM installments i
     LEFT JOIN LATERAL (
       SELECT p.approved_at, p.generation_type, p.payment_method, p.collector_id
       FROM payments p
       WHERE p.installment_id = i.id
         AND p.status = 'APPROVED'
         AND p.is_reversal = FALSE
         AND p.generation_type <> 'RENEWAL'
       ORDER BY p.approved_at DESC
       LIMIT 1
     ) lp ON TRUE
     LEFT JOIN users cu ON cu.id = lp.collector_id
     LEFT JOIN latest_next_visit lnv ON lnv.installment_id = i.id
     LEFT JOIN users sched ON sched.id = lnv.scheduled_by_user_id
     WHERE i.credit_id = $1
     ORDER BY i.installment_number`,
    [id],
  );
  credit.installments = inst.rows;
  return credit;
};

/**
 * Devuelve las unidades de producto de un crédito SALE con product_id para buscar tasas en product_rates.
 * @param {string} creditId
 * @returns {Promise<object[]>}
 */
const findCreditUnits = async (creditId) => {
  const r = await pool.query(
    `SELECT cp.id AS credit_product_id,
            cp.historical_price::float8,
            pu.id AS unit_id, pu.status AS unit_status,
            pv.id AS variant_id, pv.product_id,
            p.title
     FROM credit_products cp
     JOIN product_units    pu ON pu.id  = cp.product_unit_id
     JOIN product_variants pv ON pv.id  = pu.variant_id
     JOIN products         p  ON p.id   = pv.product_id
     WHERE cp.credit_id = $1`,
    [creditId],
  );
  return r.rows;
};

/**
 * Inserta un crédito en estado PENDING_APPROVAL con enganche y cuotas adelantadas opcionales.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - Campos del crédito; down_payment y prepaid_installments defecto 0.
 * @returns {Promise<object>} Fila insertada con los campos principales.
 */
const create = async (
  client,
  {
    customer_id,
    created_by,
    type,
    payment_condition,
    total_amount,
    down_payment,
    down_payment_method,
    down_payment_cash,
    down_payment_transfer,
    down_payment_transfer_reference,
    prepaid_installments,
    prepaid_installments_method,
    prepaid_installments_cash,
    prepaid_installments_transfer,
    prepaid_installments_transfer_reference,
    installments_count,
    payment_frequency,
    first_payment_date,
    notes,
  },
) => {
  const r = await client.query(
    `INSERT INTO credits
       (customer_id, created_by, type, payment_condition, total_amount,
         down_payment, down_payment_method, down_payment_cash, down_payment_transfer, down_payment_transfer_reference,
         prepaid_installments, prepaid_installments_method, prepaid_installments_cash, prepaid_installments_transfer, prepaid_installments_transfer_reference,
         installments_count, payment_frequency, first_payment_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id, type, payment_condition, total_amount::float8, down_payment::float8, down_payment_method,
                 down_payment_cash::float8, down_payment_transfer::float8,
                 down_payment_transfer_reference,
                 prepaid_installments::int, prepaid_installments_method,
                 prepaid_installments_cash::float8, prepaid_installments_transfer::float8,
                 prepaid_installments_transfer_reference,
                installments_count::int, payment_frequency,
                to_char(first_payment_date, 'YYYY-MM-DD') AS first_payment_date,
                status, created_at`,
    [
      customer_id,
      created_by,
      type,
      payment_condition || "FINANCED",
      total_amount,
      down_payment || 0,
      down_payment_method || null,
      down_payment_cash || 0,
      down_payment_transfer || 0,
      down_payment_transfer_reference || null,
      prepaid_installments || 0,
      prepaid_installments_method || null,
      prepaid_installments_cash || 0,
      prepaid_installments_transfer || 0,
      prepaid_installments_transfer_reference || null,
      installments_count,
      payment_frequency,
      first_payment_date || null,
      notes || null,
    ],
  );
  return r.rows[0];
};

/**
 * Vincula una unidad de producto a un crédito SALE con su precio histórico congelado.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 * @param {string} unitId
 * @param {number} historicalPrice - Precio vigente al momento de crear la pre-venta.
 */
const createCreditUnit = async (client, creditId, unitId, historicalPrice) => {
  await client.query(
    `INSERT INTO credit_products (credit_id, product_unit_id, historical_price)
     VALUES ($1, $2, $3)`,
    [creditId, unitId, historicalPrice],
  );
};

/**
 * Guarda la tasa histórica en credit_products al momento de aprobar el crédito.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditProductId
 * @param {number} rate - Tasa del product_rates vigente al momento de la aprobación.
 */
const saveHistoricalRate = async (client, creditProductId, rate) => {
  await client.query(
    `UPDATE credit_products SET historical_rate = $1 WHERE id = $2`,
    [rate, creditProductId],
  );
};

/**
 * Activa un crédito al aprobarlo: cambia status a ACTIVE y guarda tasa y cantidad de cuotas definitivas.
 * @param {object} client - Cliente de transacción.
 * @param {string} id - ID del crédito.
 * @param {string} adminId - Usuario que aprueba.
 * @param {number|null} interestRate - Tasa aplicada (null para LOAN sin tasa fija).
 * @param {number} installmentsCount - Cantidad de cuotas definitiva.
 * @param {string} [disbursementCashSessionId] - Caja operativa que entregó el efectivo (solo LOAN, rama DAILY).
 */
const approve = async (
  client,
  id,
  adminId,
  interestRate,
  installmentsCount,
  disbursementCashSessionId,
) => {
  await client.query(
    `UPDATE credits
     SET status = 'ACTIVE', approved_by = $1, approved_at = NOW(),
         interest_rate = $2, installments_count = $3,
         disbursement_cash_session_id = $5,
         updated_at = NOW()
     WHERE id = $4`,
    [adminId, interestRate ?? null, installmentsCount, id, disbursementCashSessionId ?? null],
  );
};

/**
 * Genera el cronograma de cuotas de un crédito con monto fijo y fechas precalculadas.
 * Guarda due_date como original_amount para soporte de corrimiento por pagos adelantados.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 * @param {number} installmentAmount - Monto por cuota (uniforme para todas).
 * @param {Date[]} dueDates - Fechas de vencimiento en orden.
 * @param {string} paymentFrequency - DAILY | WEEKLY | BIWEEKLY | MONTHLY.
 */
const generateInstallments = async (
  client,
  creditId,
  installmentAmount,
  dueDates,
  paymentFrequency,
) => {
  const rows = [];
  for (let i = 0; i < dueDates.length; i++) {
    const r = await client.query(
      `INSERT INTO installments
         (credit_id, installment_number, due_date, amount_due, original_amount, payment_frequency)
       VALUES ($1, $2, $3, $4, $4, $5)
       RETURNING id, installment_number, amount_due::float8`,
      [creditId, i + 1, dueDates[i], installmentAmount, paymentFrequency],
    );
    rows.push(r.rows[0]);
  }
  return rows;
};

/**
 * Reasigna el vendedor (created_by) de un crédito SOLO si sigue PENDING_APPROVAL.
 * El guard de status en el WHERE es el candado final contra cambios post-aprobación
 * (defensa ante carreras). created_by sigue siendo la única fuente de verdad del
 * vendedor; comisiones y reportes derivan de él sin cambios.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 * @param {string} sellerId - Nuevo vendedor.
 * @returns {Promise<number>} Filas afectadas (1 si se actualizó, 0 si ya no estaba pendiente).
 */
const updateCreditSeller = async (client, creditId, sellerId) => {
  const r = await client.query(
    `UPDATE credits
       SET created_by = $1, updated_at = NOW()
     WHERE id = $2 AND status = 'PENDING_APPROVAL'`,
    [sellerId, creditId],
  );
  return r.rowCount;
};

/**
 * Fija el vencimiento de las primeras N cuotas (las adelantadas) al día real de
 * aprobación del crédito. Se usa solo al aprobar una venta con cuotas adelantadas:
 * esas cuotas se cancelan en el acto, así que vencen ese día. Usa CURRENT_DATE
 * (NO la fecha de la jornada, que puede ir atrasada si la caja anterior sigue
 * abierta): dentro de la misma transacción coincide con approved_at::date del
 * pago, así vencimiento y fecha de cobro quedan en el mismo día. Preserva
 * original_due_date (la fecha que tenían en el plan) para auditoría.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 * @param {number} count - Cantidad de cuotas adelantadas desde la número 1.
 */
const setPrepaidInstallmentsDueDate = async (client, creditId, count) => {
  await client.query(
    `UPDATE installments
       SET original_due_date = COALESCE(original_due_date, due_date),
           due_date          = CURRENT_DATE,
           updated_at        = NOW()
     WHERE credit_id = $1 AND installment_number <= $2`,
    [creditId, count],
  );
};

/**
 * Registra una comisión PENDING para el vendedor al aprobar una venta (tipo SALE).
 * @param {object} client - Cliente de transacción.
 * @param {string} userId - ID del vendedor.
 * @param {string} creditId
 * @param {number} amount - Monto de la comisión (total_amount × 0.08).
 * @param {Date} weekStart - Lunes del ciclo semanal vigente.
 * @param {Date} weekEnd - Sábado del ciclo semanal vigente.
 */
const createCommission = async (
  client,
  userId,
  creditId,
  amount,
  weekStart,
  weekEnd,
) => {
  await client.query(
    `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end)
     VALUES ($1, $2, $3, 'PENDING', $4, $5)`,
    [userId, creditId, amount, weekStart, weekEnd],
  );
};

/**
 * Devuelve los IDs de las unidades de producto asociadas a un crédito SALE.
 * Se usa para liberar stock al rechazar o expirar el crédito.
 * @param {string} creditId
 * @returns {Promise<string[]>} Array de unit_id.
 */
const findCreditUnitIds = async (creditId) => {
  const r = await pool.query(
    `SELECT pu.id AS unit_id
     FROM credit_products cp
     JOIN product_units pu ON pu.id = cp.product_unit_id
     WHERE cp.credit_id = $1`,
    [creditId],
  );
  return r.rows.map((row) => row.unit_id);
};

/**
 * Devuelve las cuotas pendientes de cobro de un crédito (PENDING, OVERDUE, PARTIAL).
 * Se usa para calcular el monto de cancelación anticipada.
 * @param {string} creditId
 * @returns {Promise<object[]>}
 */
const getPendingInstallments = async (creditId) => {
  const r = await pool.query(
    `SELECT id, installment_number, amount_due::float8, amount_paid::float8, penalty_amount::float8
     FROM installments
     WHERE credit_id = $1 AND status IN ('PENDING','OVERDUE','PARTIAL')
     ORDER BY installment_number`,
    [creditId],
  );
  return r.rows;
};

/**
 * Marca todas las cuotas pendientes de un crédito como PAID con amount_paid = amount_due.
 * Se usa en cancelación anticipada dentro de una transacción atómica.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 */
const settleAllInstallments = async (client, creditId) => {
  await client.query(
    `UPDATE installments
     SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE credit_id = $1 AND status IN ('PENDING','OVERDUE','PARTIAL')`,
    [creditId],
  );
};

/**
 * Cierra un crédito activo como cancelación normal (última cuota aprobada).
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId
 */
const settleCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits
     SET status = 'SETTLED', settled_at = NOW(), settlement_type = 'NORMAL', updated_at = NOW()
     WHERE id = $1`,
    [creditId],
  );
};

/**
 * Expira créditos en PENDING_APPROVAL que superaron el límite de días sin respuesta.
 * Ejecutado por cron job según el parámetro credit_expiry_days de system_config.
 * @param {number} days - Días de gracia antes de expirar.
 * @returns {Promise<number>} Cantidad de créditos expirados.
 */
const expireOldCredits = async (days) => {
  const r = await pool.query(
    `UPDATE credits SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'PENDING_APPROVAL'
       AND created_at < NOW() - ($1 || ' days')::interval
     RETURNING id`,
    [days],
  );
  return r.rowCount;
};

/**
 * Registra un ingreso aprobado (enganche u otro pago directo) asociado a un crédito de venta.
 * No pasa por el flujo de pre-carga; se inserta ya aprobado dentro de la transacción de aprobación.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - creditId, amount, amountCash, amountTransfer, paymentMethod, transferReference, approvedBy, paymentType.
 */
const createDownPayment = async (
  client,
  {
    creditId,
    amount,
    amountCash,
    amountTransfer,
    paymentMethod,
    transferReference,
    approvedBy,
    paymentType = "DOWN_PAYMENT",
    registerDate,
    cashSessionId,
  },
) => {
  await client.query(
    `INSERT INTO credit_down_payments
       (credit_id, amount, amount_cash, amount_transfer, payment_method, transfer_reference, approved_by, payment_type, register_date, cash_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      creditId,
      amount,
      amountCash || 0,
      amountTransfer || 0,
      paymentMethod,
      transferReference || null,
      approvedBy,
      paymentType,
      registerDate,
      cashSessionId || null,
    ],
  );
};

/**
 * Bloquea un crédito para escritura exclusiva dentro de una transacción.
 * Impide que dos operaciones concurrentes (doble refinanciación, cobro simultáneo)
 * actúen sobre el mismo crédito al mismo tiempo.
 * @param {object} client - Cliente de transacción.
 * @param {string} id - ID del crédito.
 * @returns {Promise<object|null>} Fila del crédito con lock, o null si no existe.
 */
const lockCredit = async (client, id) => {
  const r = await client.query(
    `SELECT id, status, type, customer_id, payment_frequency,
            installments_count::int, total_amount::float8,
            down_payment::float8, interest_rate::float8,
            refinanced_from_credit_id
     FROM credits WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return r.rows[0] || null;
};

/**
 * Bloquea todas las cuotas de un crédito para escritura exclusiva dentro de una transacción.
 * Necesario para calcular pending_balance sin race conditions.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId - ID del crédito.
 * @returns {Promise<object[]>} Cuotas bloqueadas.
 */
const lockInstallments = async (client, creditId) => {
  const r = await client.query(
    `SELECT id, installment_number, status,
            amount_due::float8, amount_paid::float8
     FROM installments WHERE credit_id = $1 FOR UPDATE`,
    [creditId],
  );
  return r.rows;
};

/**
 * Verifica si existe algún payment PENDING asociado a las cuotas de un crédito.
 * Bloquea la refinanciación si hay cobros pendientes de confirmación.
 * @param {object} client - Cliente de transacción.
 * @param {string} creditId - ID del crédito.
 * @returns {Promise<boolean>}
 */
const hasPendingPayments = async (client, creditId) => {
  const r = await client.query(
    `SELECT 1 FROM payments p
     JOIN installments i ON i.id = p.installment_id
     WHERE i.credit_id = $1 AND p.status = 'PENDING'
     LIMIT 1`,
    [creditId],
  );
  return r.rowCount > 0;
};

/**
 * Crea un crédito LOAN de refinanciación en estado PENDING_APPROVAL.
 * Registra el vínculo al crédito original mediante refinanced_from_credit_id.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - Campos del nuevo crédito.
 * @returns {Promise<object>} Fila insertada.
 */
const createRefinancing = async (
  client,
  {
    customer_id,
    created_by,
    total_amount,
    installments_count,
    payment_frequency,
    refinanced_from_credit_id,
    notes,
  },
) => {
  const r = await client.query(
    `INSERT INTO credits
       (customer_id, created_by, type, total_amount,
        installments_count, payment_frequency,
        refinanced_from_credit_id, notes)
     VALUES ($1, $2, 'LOAN', $3, $4, $5, $6, $7)
     RETURNING id, type, total_amount::float8, installments_count::int,
               payment_frequency, status, refinanced_from_credit_id, created_at`,
    [
      customer_id,
      created_by,
      total_amount,
      installments_count,
      payment_frequency,
      refinanced_from_credit_id,
      notes || null,
    ],
  );
  return r.rows[0];
};

/**
 * Marca un crédito como REFINANCED y sus cuotas abiertas como REFINANCED.
 * Ambas operaciones ocurren en la misma transacción del llamador.
 * @param {object} client - Cliente de transacción.
 * @param {string} id - ID del crédito original.
 * @param {string} adminId - Usuario que ejecutó la refinanciación.
 * @param {string} reason - Motivo de la refinanciación.
 */
const markAsRefinanced = async (client, id, adminId, reason) => {
  await client.query(
    `UPDATE credits
     SET status = 'REFINANCED',
         refinanced_at     = NOW(),
         refinanced_by     = $1,
         refinanced_reason = $2,
         updated_at        = NOW()
     WHERE id = $3`,
    [adminId, reason, id],
  );
  // Cierra las cuotas abiertas para que no sean procesadas por el job de mora,
  // la generación de planillas ni ningún reporte de saldo pendiente.
  await client.query(
    `UPDATE installments
     SET status = 'REFINANCED', updated_at = NOW()
     WHERE credit_id = $1
       AND status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [id],
  );
};

/**
 * Inserta el registro de trazabilidad de la refinanciación.
 * Captura el snapshot financiero exacto en el momento de la operación.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - Campos del registro de refinanciación.
 * @returns {Promise<object>} Fila insertada.
 */
const createRefinancingRecord = async (
  client,
  {
    original_credit_id,
    new_credit_id,
    pending_balance,
    extra_charges,
    total_transferred,
    refinancing_type,
    reason,
    notes,
    metadata,
    executed_by,
  },
) => {
  const r = await client.query(
    `INSERT INTO credit_refinancings
       (original_credit_id, new_credit_id,
        pending_balance, extra_charges, total_transferred,
        refinancing_type, reason, notes, metadata, executed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, executed_at`,
    [
      original_credit_id,
      new_credit_id,
      pending_balance,
      extra_charges || 0,
      total_transferred,
      refinancing_type || "STANDARD",
      reason,
      notes || null,
      metadata ? JSON.stringify(metadata) : null,
      executed_by,
    ],
  );
  return r.rows[0];
};

/**
 * Reconstruye la cadena completa de refinanciaciones para un crédito dado.
 * Navega tanto hacia el origen (predecesores) como hacia los sucesores.
 * @param {string} creditId - ID del crédito de referencia.
 * @returns {Promise<object>} Objeto con predecessor, successor y cadena ordenada.
 */
const getRefinancingChain = async (creditId) => {
  // Toda la cadena desde el origen hasta el extremo más reciente
  const r = await pool.query(
    `WITH RECURSIVE
      -- Hacia atrás: desde el crédito actual hasta el origen
      ancestors AS (
        SELECT id, refinanced_from_credit_id, status, created_at, 0 AS depth
        FROM credits WHERE id = $1
        UNION ALL
        SELECT c.id, c.refinanced_from_credit_id, c.status, c.created_at, a.depth - 1
        FROM credits c JOIN ancestors a ON c.id = a.refinanced_from_credit_id
      ),
      -- Hacia adelante: desde el crédito actual hasta el más reciente
      descendants AS (
        SELECT id, refinanced_from_credit_id, status, created_at, 0 AS depth
        FROM credits WHERE id = $1
        UNION ALL
        SELECT c.id, c.refinanced_from_credit_id, c.status, c.created_at, d.depth + 1
        FROM credits c JOIN descendants d ON c.refinanced_from_credit_id = d.id
      )
      SELECT DISTINCT id, status, created_at, depth FROM (
        SELECT * FROM ancestors UNION ALL SELECT * FROM descendants
      ) all_nodes
      ORDER BY depth`,
    [creditId],
  );

  const chain = r.rows;
  const current = chain.find((n) => n.depth === 0);
  const predecessor = chain.find((n) => n.depth === -1) || null;
  // Puede haber varios a depth=1 si hubo intentos rechazados antes del actual.
  // Se prioriza el no-rechazado (PENDING_APPROVAL o ACTIVE) sobre REJECTED.
  const successor =
    chain.find((n) => n.depth === 1 && n.status !== "REJECTED") ||
    chain.find((n) => n.depth === 1) ||
    null;

  return {
    predecessor_id: predecessor?.id || null,
    successor_id: successor?.id || null,
    chain_depth: chain.length,
    chain: chain.map(({ id, status, created_at }) => ({
      id,
      status,
      created_at,
    })),
    is_refinancing: !!current?.refinanced_from_credit_id,
    is_predecessor: !!successor,
  };
};

// ── Cambio de plan ────────────────────────────────────────────────────────────

/**
 * Reescribe la cuota sobreviviente de un cambio de plan para que su saldo
 * pendiente sea exactamente `newBalance`, conservando su pago parcial previo y
 * su due_date original. Resetea la mora (el nuevo saldo ya es la deuda total al
 * nuevo plan). Mantiene la invariante amount_due = original_amount + penalty.
 * @param {object} client
 * @param {string} installmentId
 * @param {number} newBalance - Saldo nuevo que debe quedar vivo en la cuota.
 * @param {number} graceDays - Días de gracia para recalcular el status.
 */
const setSurvivingInstallment = async (client, installmentId, newBalance, graceDays) => {
  await client.query(
    `UPDATE installments
       SET original_amount = amount_paid + $2,
           penalty_amount  = 0,
           amount_due      = amount_paid + $2,
           status          = CASE
                               WHEN due_date < (CURRENT_DATE - ($3)::int * INTERVAL '1 day') THEN 'OVERDUE'
                               WHEN amount_paid > 0                                           THEN 'PARTIAL'
                               ELSE 'PENDING'
                             END,
           updated_at      = NOW()
     WHERE id = $1`,
    [installmentId, newBalance, graceDays],
  );
};

/**
 * Anula cuotas por cambio de plan (estado propio PLAN_CHANGE_CANCELLED). No toca
 * cuotas pagadas ni los pagos históricos.
 * @param {object} client
 * @param {string[]} installmentIds
 */
const cancelInstallmentsForPlanChange = async (client, installmentIds) => {
  if (!installmentIds.length) return;
  await client.query(
    `UPDATE installments
       SET status = 'PLAN_CHANGE_CANCELLED', updated_at = NOW()
     WHERE id = ANY($1::uuid[])`,
    [installmentIds],
  );
};

/**
 * Liquida un crédito por cambio de plan cuando el saldo recalculado es <= 0.
 * @param {object} client
 * @param {string} creditId
 */
const settleCreditByPlanChange = async (client, creditId) => {
  await client.query(
    `UPDATE credits
       SET status = 'SETTLED', settled_at = NOW(),
           settlement_type = 'PLAN_CHANGE', settlement_amount = 0,
           updated_at = NOW()
     WHERE id = $1`,
    [creditId],
  );
};

/**
 * Actualiza el plan vigente del crédito tras un cambio de plan: cantidad de
 * cuotas y tasa pasan a reflejar el nuevo plan. El plan/tasa originales quedan
 * preservados en credit_plan_changes (no se pierde la historia). Esto mantiene
 * coherente todo lo que lee credits.installments_count / interest_rate
 * (detalle del crédito, label "Cuota X de N" en la planilla, reportes).
 * @param {object} client
 * @param {string} creditId
 * @param {number} installmentsCount - Nueva cantidad de cuotas (= pagadas + 1).
 * @param {number} interestRate - Nueva tasa (coeficiente del plan destino).
 */
const updateCreditPlanColumns = async (
  client,
  creditId,
  installmentsCount,
  interestRate,
) => {
  await client.query(
    `UPDATE credits
       SET installments_count = $2, interest_rate = $3, updated_at = NOW()
     WHERE id = $1`,
    [creditId, installmentsCount, interestRate],
  );
};

/**
 * Devuelve los productos DISTINTOS de un crédito SALE con su tasa histórica.
 * Regla de negocio: un crédito SALE debe tener un único producto, así que esto
 * normalmente devuelve 1 fila (aunque haya varias unidades del mismo producto).
 * @param {string} creditId
 * @param {object} [db=pool] - pool o client (client si se llama bajo transacción).
 * @returns {Promise<Array<{product_id, historical_rate, product_name}>>}
 */
const getSaleCreditProducts = async (creditId, db = pool) => {
  const r = await db.query(
    `SELECT DISTINCT pv.product_id,
            cp.historical_rate::float8 AS historical_rate,
            p.title AS product_name
     FROM credit_products cp
     JOIN product_units    pu ON pu.id = cp.product_unit_id
     JOIN product_variants pv ON pv.id = pu.variant_id
     JOIN products         p  ON p.id  = pv.product_id
     WHERE cp.credit_id = $1`,
    [creditId],
  );
  return r.rows;
};

/**
 * Actualiza la tasa histórica de las líneas de producto de un crédito SALE tras
 * un cambio de plan (1 producto → todas las unidades comparten la nueva tasa).
 * La tasa original queda preservada en credit_plan_changes.
 * @param {object} client
 * @param {string} creditId
 * @param {number} newRate - Nueva tasa (coeficiente) del plan destino.
 */
const updateSaleCreditProductRate = async (client, creditId, newRate) => {
  await client.query(
    `UPDATE credit_products SET historical_rate = $2 WHERE credit_id = $1`,
    [creditId, newRate],
  );
};

/**
 * Inserta el registro de trazabilidad de un cambio de plan (snapshot antes/después).
 * @param {object} client
 * @param {object} data
 * @returns {Promise<object>} Fila insertada (id, executed_at).
 */
const createPlanChangeRecord = async (
  client,
  {
    credit_id,
    original_installments_count,
    original_rate,
    original_total,
    paid_so_far,
    pending_before,
    new_installments_count,
    new_rate,
    new_total,
    new_balance,
    surviving_installment_id,
    cancelled_installment_ids,
    credit_cancelled,
    reason,
    executed_by,
  },
) => {
  const r = await client.query(
    `INSERT INTO credit_plan_changes
       (credit_id, original_installments_count, original_rate, original_total,
        paid_so_far, pending_before, new_installments_count, new_rate, new_total,
        new_balance, surviving_installment_id, cancelled_installment_ids,
        credit_cancelled, reason, executed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, executed_at`,
    [
      credit_id,
      original_installments_count,
      original_rate,
      original_total,
      paid_so_far,
      pending_before,
      new_installments_count,
      new_rate,
      new_total,
      new_balance,
      surviving_installment_id || null,
      cancelled_installment_ids ? JSON.stringify(cancelled_installment_ids) : null,
      credit_cancelled,
      reason || null,
      executed_by,
    ],
  );
  return r.rows[0];
};

/**
 * Indica si un crédito ya tuvo un cambio de plan (solo se permite uno).
 * @param {object} db - pool o client (usar client bajo lock en la ejecución).
 * @param {string} creditId
 * @returns {Promise<boolean>}
 */
const hasPlanChange = async (db, creditId) => {
  const r = await db.query(
    `SELECT 1 FROM credit_plan_changes WHERE credit_id = $1 LIMIT 1`,
    [creditId],
  );
  return r.rowCount > 0;
};

// ── Castigo de crédito (write off) ────────────────────────────────────────────

/**
 * Marca como WRITTEN_OFF las cuotas abiertas de un crédito castigado. Las cuotas
 * PAID no se tocan. Salen así de saldo, planilla y del cron de mora.
 * @param {object} client
 * @param {string} creditId
 */
const writeOffInstallments = async (client, creditId) => {
  await client.query(
    `UPDATE installments
       SET status = 'WRITTEN_OFF', updated_at = NOW()
     WHERE credit_id = $1
       AND status IN ('PENDING', 'PARTIAL', 'OVERDUE')`,
    [creditId],
  );
};

/**
 * Marca un crédito como castigado (WRITTEN_OFF). NO escribe motivo/fecha/usuario
 * acá: la auditoría vive únicamente en credit_write_offs.
 * @param {object} client
 * @param {string} creditId
 */
const writeOffCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits SET status = 'WRITTEN_OFF', updated_at = NOW() WHERE id = $1`,
    [creditId],
  );
};

/**
 * Inserta el registro de auditoría del castigo (único lugar de trazabilidad).
 * @param {object} client
 * @param {object} data - credit_id, written_off_balance, reason, observations, executed_by.
 * @returns {Promise<object>} Fila insertada (id, executed_at).
 */
const createWriteOffRecord = async (
  client,
  { credit_id, written_off_balance, reason, observations, executed_by },
) => {
  const r = await client.query(
    `INSERT INTO credit_write_offs
       (credit_id, written_off_balance, reason, observations, executed_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, executed_at`,
    [credit_id, written_off_balance, reason, observations || null, executed_by],
  );
  return r.rows[0];
};

module.exports = {
  findAll,
  findById,
  findCreditUnits,
  findCreditUnitIds,
  create,
  createCreditUnit,
  saveHistoricalRate,
  approve,
  generateInstallments,
  setPrepaidInstallmentsDueDate,
  updateCreditSeller,
  createCommission,
  createDownPayment,
  getPendingInstallments,
  settleAllInstallments,
  settleCredit,
  expireOldCredits,
  // refinanciación
  lockCredit,
  lockInstallments,
  hasPendingPayments,
  createRefinancing,
  markAsRefinanced,
  createRefinancingRecord,
  getRefinancingChain,
  // cambio de plan
  setSurvivingInstallment,
  cancelInstallmentsForPlanChange,
  settleCreditByPlanChange,
  updateCreditPlanColumns,
  getSaleCreditProducts,
  updateSaleCreditProductRate,
  createPlanChangeRecord,
  hasPlanChange,
  // castigo (write off)
  writeOffInstallments,
  writeOffCredit,
  createWriteOffRecord,
};
