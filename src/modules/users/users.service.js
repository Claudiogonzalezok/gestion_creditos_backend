const bcrypt  = require('bcryptjs');
const pool    = require('../../config/db');
const queries = require('./users.queries');
const { withTransaction } = require('../../utils/transaction');
const { generateTempPassword } = require('../../utils/tempPassword');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

/**
 * Ejecuta fn dentro de una transacción con un client dedicado.
 * @param {Function} fn - recibe el client
 * @returns {Promise<*>} lo que devuelva fn
 */
const _withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

const getAll = async (filters) => {
  return queries.findAll(filters);
};

const getById = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  return user;
};

const getOwnProfile = async (id) => {
  const user = await queries.findOwnProfileById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  return user;
};

const create = async ({ full_name, dni, email = null, address = null, role }) => {
  // Validar DNI único
  if (await queries.findByDni(dni))
    throw { status: 409, message: 'Ya existe un usuario registrado con ese DNI.' };

  // Validar email único solo si fue proporcionado
  if (email && await queries.findByEmail(email))
    throw { status: 409, message: 'Ya existe un usuario registrado con ese email.' };

  const tempPassword  = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  let user;
  try {
    user = await queries.create({ full_name, dni, email, address, password_hash, role });
  } catch (err) {
    // Alta concurrente con el mismo DNI: el chequeo previo pasó en ambas, la
    // unique constraint frena la segunda (#49) → 409, no 500.
    if (err.code === '23505')
      throw { status: 409, message: 'Ya existe un usuario registrado con ese DNI.' };
    throw err;
  }

  return { user, tempPassword };
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Usuario no encontrado.' };

  if (data.dni && data.dni !== existing.dni) {
    const taken = await queries.findByDni(data.dni);
    if (taken && taken.id !== id)
      throw { status: 409, message: 'Ya existe un usuario registrado con ese DNI.' };
  }

  if (data.email && data.email !== existing.email) {
    const taken = await queries.findByEmail(data.email);
    if (taken && taken.id !== id)
      throw { status: 409, message: 'Ya existe un usuario registrado con ese email.' };
  }

  const roleCambia = data.role && data.role !== existing.role;

  if (roleCambia && existing.role === 'ADMIN') {
    const admins = await queries.countActiveAdmins();
    if (admins <= 1)
      throw { status: 409, message: 'No es posible cambiar el rol del único administrador activo del sistema.' };
  }

  // Un cobrador con clientes asignados no puede cambiar de rol
  if (roleCambia && ['COLLECTOR','SELLER_COLLECTOR'].includes(existing.role)) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM customers WHERE assigned_collector_id = $1 AND status = 'ACTIVE'`,
      [id]
    );
    if (parseInt(rows[0].count) > 0)
      throw { status: 409, message: 'No es posible cambiar el rol porque el usuario tiene clientes asignados. Reasignelos primero.' };
  }

  if (!roleCambia) return queries.update(id, data);

  // Cambio de rol (CU02): el UPDATE y el cierre de sesiones van en la misma
  // transacción, para que el rol nunca quede aplicado con sesiones vivas (#42).
  return _withTransaction(async (client) => {
    const updated = await queries.update(id, data, client);
    await queries.invalidateSessions(id, client);
    return updated;
  });
};

const updateOwnProfile = async (id, data) => {
  const existing = await queries.findOwnProfileById(id);
  if (!existing) throw { status: 404, message: 'Usuario no encontrado.' };

  if (data.email && data.email !== existing.email) {
    const taken = await queries.findByEmail(data.email);
    if (taken && taken.id !== id)
      throw { status: 409, message: 'Ya existe un usuario registrado con ese email.' };
  }

  return queries.updateOwnProfile(id, data);
};

/**
 * Desactiva un usuario. La guarda del último admin corre en una transacción
 * con lock sobre los admins activos (#49): dos desactivaciones cruzadas en
 * paralelo se serializan y nunca dejan el sistema con 0 admins activos.
 * @param {string} id
 */
const deactivate = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  if (user.status === 'INACTIVE') throw { status: 409, message: 'El usuario ya está inactivo.' };

  if (['COLLECTOR','SELLER_COLLECTOR'].includes(user.role)) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM customers WHERE assigned_collector_id = $1 AND status = 'ACTIVE'`,
      [id]
    );
    if (parseInt(rows[0].count) > 0)
      throw { status: 409, message: 'No es posible desactivar el usuario porque tiene clientes asignados. Reasignelos primero.' };
  }

  await withTransaction(async (client) => {
    if (user.role === 'ADMIN') {
      await queries.lockActiveAdmins(client);
      const admins = await queries.countActiveAdmins(client);
      if (admins <= 1)
        throw { status: 409, message: 'No es posible desactivar el único administrador activo del sistema.' };
    }
    const done = await queries.deactivate(id, client);
    if (!done) throw { status: 409, message: 'El usuario ya está inactivo.' };
    // Desactivar cierra todas las sesiones del usuario (#42).
    await queries.invalidateSessions(id, client);
  });
};

const activate = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  if (user.status === 'ACTIVE') throw { status: 409, message: 'El usuario ya está activo.' };
  await queries.activate(id);
};

const resetPassword = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };

  const tempPassword  = generateTempPassword();
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  // Resetear la contraseña cierra todas las sesiones previas (#42).
  await _withTransaction(async (client) => {
    await queries.resetPassword(id, password_hash, client);
    await queries.invalidateSessions(id, client);
  });

  return { tempPassword };
};

const changePassword = async (id, currentPassword, newPassword) => {
  // Obtener el hash desde la DB (findById no lo expone por seguridad)
  const result = await pool.query(
    'SELECT password_hash FROM users WHERE id = $1', [id]
  );
  if (!result.rows.length) throw { status: 404, message: 'Usuario no encontrado.' };

  const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!valid) throw { status: 401, message: 'La contraseña actual es incorrecta.' };
  if (currentPassword === newPassword)
    throw { status: 400, message: 'La nueva contraseña no puede ser igual a la actual.' };

  const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await queries.changePassword(id, password_hash);
};

const unlock = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  if (!user.locked_at) throw { status: 409, message: 'El usuario no está bloqueado.' };
  await queries.unlock(id);
};

module.exports = {
  getAll, getById, getOwnProfile, create, update, updateOwnProfile,
  deactivate, activate, resetPassword, changePassword, unlock,
};
