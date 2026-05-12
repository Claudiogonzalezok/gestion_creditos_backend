const pool = require("../../config/db");

/**
 * Lista feriados con filtros opcionales.
 * @param {object} filters - Filtros por type, active y affects_due_dates.
 * @returns {Promise<object[]>} Feriados ordenados por fecha ascendente.
 */
const findAll = async ({ type, active, affects_due_dates } = {}) => {
  let q = `
    SELECT id, date, name, type, affects_due_dates, active, repeats_annually, created_at, updated_at
    FROM holidays
    WHERE 1=1`;
  const params = [];
  if (type) {
    params.push(type);
    q += ` AND type = $${params.length}`;
  }
  if (active !== undefined) {
    params.push(active);
    q += ` AND active = $${params.length}`;
  }
  if (affects_due_dates !== undefined) {
    params.push(affects_due_dates);
    q += ` AND affects_due_dates = $${params.length}`;
  }
  q += " ORDER BY date ASC, created_at DESC";
  return (await pool.query(q, params)).rows;
};

/**
 * Busca un feriado por ID.
 * @param {string} id - Identificador del feriado.
 * @returns {Promise<object|null>} Feriado encontrado o null.
 */
const findById = async (id) => {
  const r = await pool.query(
    `SELECT id, date, name, type, affects_due_dates, active, repeats_annually, created_at, updated_at
     FROM holidays
     WHERE id = $1`,
    [id],
  );
  return r.rows[0] || null;
};

/**
 * Inserta un nuevo feriado.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - Datos del feriado.
 * @returns {Promise<object>} Feriado creado.
 */
const create = async (
  client,
  { date, name, type, affects_due_dates, active, repeats_annually },
) => {
  const r = await client.query(
    `INSERT INTO holidays (date, name, type, affects_due_dates, active, repeats_annually)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, date, name, type, affects_due_dates, active, repeats_annually, created_at, updated_at`,
    [date, name, type, affects_due_dates, active, repeats_annually],
  );
  return r.rows[0];
};

/**
 * Actualiza los campos editables de un feriado existente.
 * @param {string} id - ID del feriado.
 * @param {object} data - Campos a actualizar.
 * @returns {Promise<object|null>} Feriado actualizado o null.
 */
const update = async (id, { name, type, affects_due_dates, active, repeats_annually }) => {
  const r = await pool.query(
    `UPDATE holidays
     SET name = COALESCE($2, name),
         type = COALESCE($3, type),
         affects_due_dates = COALESCE($4, affects_due_dates),
         active = COALESCE($5, active),
         repeats_annually = COALESCE($6, repeats_annually),
         updated_at = NOW()
      WHERE id = $1
     RETURNING id, date, name, type, affects_due_dates, active, repeats_annually, created_at, updated_at`,
    [id, name ?? null, type ?? null, affects_due_dates ?? null, active ?? null, repeats_annually ?? null],
  );
  return r.rows[0] || null;
};

/**
 * Recalcula cuotas futuras pendientes que vencen exactamente en una fecha dada.
 * Solo toca cuotas PENDING, no vencidas y no pagadas.
 * @param {object} client - Cliente de transacción.
 * @param {object} data - Configuración del recálculo por feriado.
 * @returns {Promise<object[]>} Cuotas que fueron actualizadas.
 */
const recalculateFutureInstallmentsByExactDate = async (
  client,
  { targetDate, newDueDate },
) => {
  const r = await client.query(
    `UPDATE installments i
     SET original_due_date = COALESCE(i.original_due_date, i.due_date),
         due_date = $2::date,
         updated_at = NOW()
     WHERE i.due_date = $1::date
       AND i.status = 'PENDING'
       AND i.due_date >= CURRENT_DATE
       AND i.amount_paid = 0
     RETURNING i.id, i.credit_id, i.installment_number, i.original_due_date, i.due_date`,
    [targetDate, newDueDate],
  );
  return r.rows;
};

/**
 * Recupera feriados activos de un año origen para evaluar duplicación anual.
 * @param {number} sourceYear - Año origen.
 * @returns {Promise<object[]>} Feriados activos del año origen.
 */
const findActiveByYear = async (sourceYear) => {
  const r = await pool.query(
    `SELECT id, date, name, type, affects_due_dates, active, repeats_annually
     FROM holidays
     WHERE EXTRACT(YEAR FROM date) = $1
       AND active = true
      ORDER BY date ASC, created_at ASC`,
    [sourceYear],
  );
  return r.rows;
};

/**
 * Lista combinaciones existentes de fecha y tipo en un año destino.
 * @param {number} targetYear - Año destino.
 * @returns {Promise<object[]>} Registros existentes para evitar duplicados.
 */
const findExistingDateTypeByYear = async (targetYear) => {
  const r = await pool.query(
    `SELECT date, type
     FROM holidays
     WHERE EXTRACT(YEAR FROM date) = $1`,
    [targetYear],
  );
  return r.rows;
};

/**
 * Inserta en lote los feriados nuevos calculados para el año destino.
 * @param {object} client - Cliente de transacción.
 * @param {Array<{date:string,name:string,type:string,affects_due_dates:boolean,active:boolean,repeats_annually:boolean}>} items - Feriados a crear.
 * @returns {Promise<object[]>} Feriados efectivamente creados.
 */
const bulkCreate = async (client, items) => {
  if (!items.length) return [];

  const values = [];
  const placeholders = [];

  items.forEach((item, index) => {
    const base = index * 6;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
    );
    values.push(
      item.date,
      item.name,
      item.type,
      item.affects_due_dates,
      item.active,
      item.repeats_annually,
    );
  });

  const r = await client.query(
    `INSERT INTO holidays (date, name, type, affects_due_dates, active, repeats_annually)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (date, type) DO NOTHING
     RETURNING id, date, name, type, affects_due_dates, active, repeats_annually, created_at, updated_at`,
    values,
  );

  return r.rows;
};

module.exports = {
  findAll,
  findById,
  create,
  update,
  recalculateFutureInstallmentsByExactDate,
  findActiveByYear,
  findExistingDateTypeByYear,
  bulkCreate,
};
