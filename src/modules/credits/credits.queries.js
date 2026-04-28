const pool = require('../../config/db');

const findAll = async ({ status, type, customer_id, created_by } = {}) => {
  let q = `
    SELECT c.id, c.type, c.total_amount::float8, c.installments_count::int, c.payment_frequency,
           c.interest_rate::float8, c.status, c.created_at, c.approved_at,
           cu.id AS customer_id, cu.full_name AS customer_name, cu.dni AS customer_dni,
           u.id  AS created_by_id, u.full_name AS created_by_name
    FROM credits c
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN users u ON u.id = c.created_by
    WHERE 1=1`;
  const params = [];
  if (status)      { params.push(status);      q += ` AND c.status = $${params.length}`; }
  if (type)        { params.push(type);        q += ` AND c.type = $${params.length}`; }
  if (customer_id) { params.push(customer_id); q += ` AND c.customer_id = $${params.length}`; }
  if (created_by)  { params.push(created_by);  q += ` AND c.created_by = $${params.length}`; }
  q += ` ORDER BY c.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

const findById = async (id) => {
  const r = await pool.query(
    `SELECT c.id, c.type, c.total_amount::float8, c.down_payment::float8,
            c.down_payment_method, c.down_payment_transfer_reference,
            c.prepaid_installments::int, c.prepaid_installments_method,
            c.prepaid_installments_transfer_reference,
            c.installments_count::int, c.payment_frequency,
            c.interest_rate::float8, c.status, c.rejection_reason, c.notes, c.created_by,
            c.created_at, c.approved_at, c.approved_by,
            c.settled_at, c.settlement_amount::float8, c.settlement_type,
            cu.id AS customer_id, cu.full_name AS customer_name, cu.dni AS customer_dni,
            cu.phone AS customer_phone,
            u.id AS created_by_id, u.full_name AS created_by_name
     FROM credits c
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const credit = r.rows[0];

  if (credit.type === 'SALE') {
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
      [id]
    );
    credit.units = units.rows;
  }

  const inst = await pool.query(
    `SELECT id, installment_number, due_date,
            amount_due::float8, amount_paid::float8, penalty_amount::float8, status
     FROM installments WHERE credit_id = $1 ORDER BY installment_number`,
    [id]
  );
  credit.installments = inst.rows;
  return credit;
};

// Devuelve las unidades de un crédito SALE con product_id para agrupar tasas
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
    [creditId]
  );
  return r.rows;
};

const create = async (client, {
  customer_id, created_by, type, total_amount,
  down_payment, down_payment_method, down_payment_transfer_reference,
  prepaid_installments, prepaid_installments_method, prepaid_installments_transfer_reference,
  installments_count, payment_frequency, notes,
}) => {
  const r = await client.query(
    `INSERT INTO credits
       (customer_id, created_by, type, total_amount,
        down_payment, down_payment_method, down_payment_transfer_reference,
        prepaid_installments, prepaid_installments_method, prepaid_installments_transfer_reference,
        installments_count, payment_frequency, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, type, total_amount::float8, down_payment::float8, down_payment_method,
               prepaid_installments::int, prepaid_installments_method,
               installments_count::int, payment_frequency, status, created_at`,
    [
      customer_id, created_by, type, total_amount,
      down_payment || 0, down_payment_method || null, down_payment_transfer_reference || null,
      prepaid_installments || 0, prepaid_installments_method || null, prepaid_installments_transfer_reference || null,
      installments_count, payment_frequency, notes || null,
    ]
  );
  return r.rows[0];
};

const createCreditUnit = async (client, creditId, unitId, historicalPrice) => {
  await client.query(
    `INSERT INTO credit_products (credit_id, product_unit_id, historical_price)
     VALUES ($1, $2, $3)`,
    [creditId, unitId, historicalPrice]
  );
};

const saveHistoricalRate = async (client, creditProductId, rate) => {
  await client.query(
    `UPDATE credit_products SET historical_rate = $1 WHERE id = $2`,
    [rate, creditProductId]
  );
};

const approve = async (client, id, adminId, interestRate, installmentsCount) => {
  await client.query(
    `UPDATE credits
     SET status = 'ACTIVE', approved_by = $1, approved_at = NOW(),
         interest_rate = $2, installments_count = $3, updated_at = NOW()
     WHERE id = $4`,
    [adminId, interestRate ?? null, installmentsCount, id]
  );
};

const generateInstallments = async (client, creditId, installmentAmount, dueDates, paymentFrequency) => {
  for (let i = 0; i < dueDates.length; i++) {
    await client.query(
      `INSERT INTO installments
         (credit_id, installment_number, due_date, amount_due, original_amount, payment_frequency)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [creditId, i + 1, dueDates[i], installmentAmount, paymentFrequency]
    );
  }
};

const createCommission = async (client, userId, creditId, amount, weekStart, weekEnd) => {
  await client.query(
    `INSERT INTO commissions (user_id, credit_id, amount, status, week_start, week_end)
     VALUES ($1, $2, $3, 'PENDING', $4, $5)`,
    [userId, creditId, amount, weekStart, weekEnd]
  );
};

const reject = async (id, rejectionReason, adminId) => {
  await pool.query(
    `UPDATE credits
     SET status = 'REJECTED', rejection_reason = $1, approved_by = $2,
         approved_at = NOW(), updated_at = NOW()
     WHERE id = $3`,
    [rejectionReason, adminId, id]
  );
};

const findCreditUnitIds = async (creditId) => {
  const r = await pool.query(
    `SELECT pu.id AS unit_id
     FROM credit_products cp
     JOIN product_units pu ON pu.id = cp.product_unit_id
     WHERE cp.credit_id = $1`,
    [creditId]
  );
  return r.rows.map((row) => row.unit_id);
};

const getPendingInstallments = async (creditId) => {
  const r = await pool.query(
    `SELECT id, installment_number, amount_due::float8, amount_paid::float8, penalty_amount::float8
     FROM installments
     WHERE credit_id = $1 AND status IN ('PENDING','OVERDUE','PARTIAL')
     ORDER BY installment_number`,
    [creditId]
  );
  return r.rows;
};

const settleAllInstallments = async (client, creditId) => {
  await client.query(
    `UPDATE installments
     SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE credit_id = $1 AND status IN ('PENDING','OVERDUE','PARTIAL')`,
    [creditId]
  );
};

const settleCredit = async (client, creditId) => {
  await client.query(
    `UPDATE credits
     SET status = 'SETTLED', settled_at = NOW(), settlement_type = 'NORMAL', updated_at = NOW()
     WHERE id = $1`,
    [creditId]
  );
};

const expireOldCredits = async (days) => {
  const r = await pool.query(
    `UPDATE credits SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'PENDING_APPROVAL'
       AND created_at < NOW() - ($1 || ' days')::interval
     RETURNING id`,
    [days]
  );
  return r.rowCount;
};

const createDownPayment = async (client, { creditId, amount, paymentMethod, transferReference, approvedBy, paymentType = 'DOWN_PAYMENT' }) => {
  await client.query(
    `INSERT INTO credit_down_payments
       (credit_id, amount, payment_method, transfer_reference, approved_by, payment_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [creditId, amount, paymentMethod, transferReference || null, approvedBy, paymentType]
  );
};

const markPrepaidInstallments = async (client, creditId, count) => {
  const r = await client.query(
    `UPDATE installments
     SET status = 'PAID', amount_paid = amount_due, updated_at = NOW()
     WHERE credit_id = $1 AND installment_number <= $2
     RETURNING amount_due::float8`,
    [creditId, count]
  );
  return r.rows.reduce((sum, row) => sum + row.amount_due, 0);
};

module.exports = {
  findAll, findById, findCreditUnits, findCreditUnitIds,
  create, createCreditUnit, saveHistoricalRate,
  approve, generateInstallments, createCommission,
  createDownPayment, markPrepaidInstallments,
  reject, getPendingInstallments, settleAllInstallments, settleCredit,
  expireOldCredits,
};
