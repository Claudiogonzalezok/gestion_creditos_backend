// Fixtures de negocio para tests de integration.
// Insertan datos directos en la DB sin pasar por services (más rápido y permite
// crear estados arbitrarios para edge cases — ej. cuotas OVERDUE con saldo X).
//
// Todos los fixtures:
//   · Auto-crean dependencias (customer, credit) si no se proveen.
//   · Aceptan overrides parciales sobre defaults razonables.
//   · Devuelven la fila insertada con ids para encadenar.
//
// Uso típico:
//   const inst = await createInstallmentFixture({
//     due_date:        daysAgo(10),
//     original_amount: 1000,
//     amount_paid:     300,
//     status:          'OVERDUE',
//   });

const { pool } = require('./db');
const { today } = require('./dates');

let dniCounter = 100000000; // Contador local para generar DNIs únicos por suite.
const nextDni = () => String(++dniCounter).slice(-10);

/**
 * Crea un customer mínimo.
 * @param {object} overrides
 * @returns {Promise<object>} { id, full_name, dni, status }
 */
const createCustomerFixture = async (overrides = {}) => {
  const data = {
    full_name: 'Test Customer',
    dni:       nextDni(),
    address:   'Calle Test 123',
    phone:     '1100000000',
    email:     null,
    status:    'ACTIVE',
    ...overrides,
  };
  const r = await pool.query(
    `INSERT INTO customers (full_name, dni, address, phone, email, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, dni, status`,
    [data.full_name, data.dni, data.address, data.phone, data.email, data.status]
  );
  return r.rows[0];
};

/**
 * Crea un crédito ACTIVE LOAN mínimo. Auto-crea customer si no se pasa customer_id.
 * @param {object} overrides
 * @returns {Promise<object>} { id, customer_id, status, type, ... }
 */
const createCreditFixture = async (overrides = {}) => {
  const customerId = overrides.customer_id || (await createCustomerFixture()).id;

  const data = {
    type:               'LOAN',
    total_amount:       1000,
    installments_count: 1,
    payment_frequency:  'WEEKLY',
    status:             'ACTIVE',
    approved_at:        new Date(),
    interest_rate:      null,
    down_payment:       0,
    prepaid_installments: 0,
    notes:              null,
    ...overrides,
    customer_id:        customerId, // forzado: el customerId resuelto siempre gana
  };

  const r = await pool.query(
    `INSERT INTO credits
       (customer_id, type, total_amount, installments_count, payment_frequency,
        status, approved_at, interest_rate, down_payment, prepaid_installments, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, customer_id, type, total_amount::float8, installments_count,
               payment_frequency, status`,
    [data.customer_id, data.type, data.total_amount, data.installments_count,
     data.payment_frequency, data.status, data.approved_at, data.interest_rate,
     data.down_payment, data.prepaid_installments, data.notes]
  );
  return r.rows[0];
};

/**
 * Crea una cuota. Auto-crea credit si no se pasa credit_id.
 * Mantiene la invariante amount_due = original_amount + penalty_amount.
 * @param {object} overrides
 * @returns {Promise<object>} fila completa de installments
 */
const createInstallmentFixture = async (overrides = {}) => {
  const creditId = overrides.credit_id || (await createCreditFixture()).id;

  const data = {
    installment_number:       1,
    due_date:                 today(),
    payment_frequency:        'WEEKLY',
    original_amount:          1000,
    penalty_amount:           0,
    amount_paid:              0,
    status:                   'PENDING',
    last_penalty_applied_at:  null,
    ...overrides,
    credit_id:                creditId,
  };

  // Invariante: amount_due se deriva de original + penalty.
  // Permitimos override explícito para casos de test de inconsistencias.
  const amountDue = overrides.amount_due !== undefined
    ? overrides.amount_due
    : data.original_amount + data.penalty_amount;

  const r = await pool.query(
    `INSERT INTO installments
       (credit_id, installment_number, due_date, payment_frequency,
        original_amount, penalty_amount, amount_due, amount_paid, status,
        last_penalty_applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, credit_id, installment_number, due_date,
               original_amount::float8, penalty_amount::float8,
               amount_due::float8, amount_paid::float8, status,
               last_penalty_applied_at`,
    [data.credit_id, data.installment_number, data.due_date, data.payment_frequency,
     data.original_amount, data.penalty_amount, amountDue, data.amount_paid, data.status,
     data.last_penalty_applied_at]
  );
  return r.rows[0];
};

/**
 * Marca un registro en cron_execution_log como si el job ya hubiera corrido
 * con éxito un día específico. Útil para tests de catch-up que necesitan que
 * NO sea "primera corrida".
 * @param {string} jobName
 * @param {string} finishedDate - 'YYYY-MM-DD' del día de la corrida.
 */
const seedCronLogSuccess = async (jobName, finishedDate) => {
  await pool.query(
    `INSERT INTO cron_execution_log
       (job_name, started_at, finished_at, success, affected_rows)
     VALUES ($1, ($2::date)::timestamptz, ($2::date)::timestamptz, TRUE, 0)`,
    [jobName, finishedDate]
  );
};

/**
 * Re-lee una cuota desde la DB por id (útil después de ejecutar el job o un service).
 * @param {string} id
 * @returns {Promise<object|null>}
 */
const reloadInstallment = async (id) => {
  const r = await pool.query(
    `SELECT id, credit_id, installment_number, due_date,
            original_amount::float8, penalty_amount::float8,
            amount_due::float8, amount_paid::float8, status, updated_at,
            last_penalty_applied_at
     FROM installments
     WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
};

/**
 * Crea un usuario interno mínimo (admin/cobrador) para tests que necesitan
 * un user_id válido (ej. payments.collector_id, payments.approved_by).
 * @param {object} overrides
 * @returns {Promise<object>} { id, role, full_name, dni }
 */
const createUserFixture = async (overrides = {}) => {
  const data = {
    full_name:        'Test User',
    dni:              nextDni().slice(0, 9),  // VARCHAR(9) en users
    password_hash:    '$2a$04$placeholderhashfortestsonly',
    role:             'ADMIN',
    status:           'ACTIVE',
    is_temp_password: false,
    ...overrides,
  };
  const r = await pool.query(
    `INSERT INTO users (full_name, dni, password_hash, role, status, is_temp_password)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, dni, role, status`,
    [data.full_name, data.dni, data.password_hash, data.role, data.status, data.is_temp_password]
  );
  return r.rows[0];
};

/**
 * Crea una pre-carga (payment PENDING) directamente en DB. Auto-crea cuota
 * y cobrador si no se pasan.
 * @param {object} overrides
 * @returns {Promise<object>} fila completa del payment insertado
 */
const createPendingPaymentFixture = async (overrides = {}) => {
  const installmentId = overrides.installment_id ||
    (await createInstallmentFixture(overrides._installmentOverrides || {})).id;
  const collectorId   = overrides.collector_id ||
    (await createUserFixture({ role: 'COLLECTOR' })).id;

  const data = {
    amount_received:    100,
    payment_method:     'CASH',
    transfer_reference: null,
    notes:              null,
    next_visit_date:    null,
    status:             'PENDING',
    ...overrides,
    installment_id:     installmentId,
    collector_id:       collectorId,
  };

  const r = await pool.query(
    `INSERT INTO payments
       (installment_id, collector_id, amount_received, amount_cash, amount_transfer, payment_method, transfer_reference,
        notes, next_visit_date, status)
     VALUES ($1, $2, $3,
             CASE WHEN $4 = 'CASH'     THEN $3::numeric ELSE 0 END,
             CASE WHEN $4 = 'TRANSFER' THEN $3::numeric ELSE 0 END,
             $4, $5, $6, $7, $8)
     RETURNING id, installment_id, collector_id, amount_received::float8,
               payment_method, status, created_at`,
    [data.installment_id, data.collector_id, data.amount_received, data.payment_method,
     data.transfer_reference, data.notes, data.next_visit_date, data.status]
  );
  return r.rows[0];
};

module.exports = {
  createCustomerFixture,
  createCreditFixture,
  createInstallmentFixture,
  createUserFixture,
  createPendingPaymentFixture,
  seedCronLogSuccess,
  reloadInstallment,
};
