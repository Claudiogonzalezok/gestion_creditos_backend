const pool = require('../../config/db');

const findAll = async ({ status, type, customer_id, created_by } = {}) => {
  let q = `
    SELECT c.id, c.type, c.total_amount, c.installments_count, c.payment_frequency,
           c.interest_rate, c.status, c.created_at, c.approved_at,
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
    `SELECT c.id, c.type, c.total_amount, c.installments_count, c.payment_frequency,
            c.interest_rate, c.status, c.rejection_reason, c.notes, c.created_by,
            c.created_at, c.approved_at, c.approved_by,
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
    const products = await pool.query(
      `SELECT cp.id, cp.quantity, cp.historical_price,
              p.id AS product_id, p.name AS product_name
       FROM credit_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.credit_id = $1`, [id]
    );
    credit.products = products.rows;
  }

  const inst = await pool.query(
    `SELECT id, installment_number, due_date, amount_due, amount_paid, penalty_amount, status
     FROM installments WHERE credit_id = $1 ORDER BY installment_number`,
    [id]
  );
  credit.installments = inst.rows;
  return credit;
};

const findCreditProducts = async (creditId) => {
  const r = await pool.query(
    `SELECT cp.product_id, cp.quantity, cp.historical_price, p.available_stock, p.name
     FROM credit_products cp
     JOIN products p ON p.id = cp.product_id
     WHERE cp.credit_id = $1`,
    [creditId]
  );
  return r.rows;
};

const create = async (client, { customer_id, created_by, type, total_amount, installments_count, payment_frequency, notes }) => {
  const r = await client.query(
    `INSERT INTO credits (customer_id, created_by, type, total_amount, installments_count, payment_frequency, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, type, total_amount, installments_count, payment_frequency, status, created_at`,
    [customer_id, created_by, type, total_amount, installments_count, payment_frequency, notes || null]
  );
  return r.rows[0];
};

const createCreditProducts = async (client, creditId, products) => {
  for (const p of products) {
    await client.query(
      `INSERT INTO credit_products (credit_id, product_id, quantity, historical_price)
       VALUES ($1, $2, $3, $4)`,
      [creditId, p.product_id, p.quantity, p.historical_price]
    );
  }
};

const approve = async (client, id, adminId, interestRate, installmentsCount) => {
  await client.query(
    `UPDATE credits
     SET status = 'ACTIVE', approved_by = $1, approved_at = NOW(),
         interest_rate = $2, installments_count = $3, updated_at = NOW()
     WHERE id = $4`,
    [adminId, interestRate, installmentsCount, id]
  );
};

const generateInstallments = async (client, creditId, installmentAmount, dueDates) => {
  for (let i = 0; i < dueDates.length; i++) {
    await client.query(
      `INSERT INTO installments (credit_id, installment_number, due_date, amount_due)
       VALUES ($1, $2, $3, $4)`,
      [creditId, i + 1, dueDates[i], installmentAmount]
    );
  }
};

const decrementProductStock = async (client, productId, quantity, reason, adminId) => {
  const updated = await client.query(
    `UPDATE products SET available_stock = available_stock - $1, updated_at = NOW()
     WHERE id = $2 RETURNING available_stock`,
    [quantity, productId]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, movement, quantity, reason, available_stock_after, user_id)
     VALUES ($1, 'OUT', $2, $3, $4, $5)`,
    [productId, quantity, reason, updated.rows[0].available_stock, adminId]
  );
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

const getPendingInstallments = async (creditId) => {
  const r = await pool.query(
    `SELECT id, installment_number, amount_due, amount_paid, penalty_amount
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
    `UPDATE credits SET status = 'SETTLED', updated_at = NOW() WHERE id = $1`,
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

module.exports = {
  findAll, findById, findCreditProducts,
  create, createCreditProducts,
  approve, generateInstallments, decrementProductStock, createCommission,
  reject, getPendingInstallments, settleAllInstallments, settleCredit,
  expireOldCredits,
};
