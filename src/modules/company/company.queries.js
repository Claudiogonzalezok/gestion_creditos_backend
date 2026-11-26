const pool = require('../../config/db');

const COLUMNS = `system_name, contact_email, phone, address, updated_at, updated_by`;

/**
 * Lee la fila única de datos de la empresa. Si falta (DB sin migración 053
 * aplicada a mano), la crea con los defaults.
 * @returns {Promise<object>}
 */
const getSettings = async () => {
  const r = await pool.query(
    `INSERT INTO company_settings (id) VALUES (1)
     ON CONFLICT (id) DO UPDATE SET id = company_settings.id
     RETURNING ${COLUMNS}`
  );
  return r.rows[0];
};

/**
 * Actualiza solo los campos recibidos (undefined = no tocar; null = vaciar).
 * @param {object} data - { system_name?, contact_email?, phone?, address? }
 * @param {string} userId
 * @returns {Promise<object>}
 */
const updateSettings = async (data, userId) => {
  const fields = ['system_name', 'contact_email', 'phone', 'address'];
  const sets = [];
  const values = [];
  for (const field of fields) {
    if (data[field] !== undefined) {
      // "" en campos opcionales se guarda como NULL.
      values.push(field !== 'system_name' && data[field] === '' ? null : data[field]);
      sets.push(`${field} = $${values.length}`);
    }
  }
  values.push(userId);
  sets.push(`updated_by = $${values.length}`, 'updated_at = NOW()');
  await getSettings(); // garantiza que la fila exista
  const r = await pool.query(
    `UPDATE company_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING ${COLUMNS}`,
    values
  );
  return r.rows[0];
};

module.exports = { getSettings, updateSettings };
