const bcrypt  = require('bcryptjs');
const queries = require('./users.queries');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

// Generar contraseña temporal aleatoria (8 caracteres alfanuméricos)
const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 8; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
};

const getAll = async (filters) => {
  return queries.findAll(filters);
};

const getById = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  return user;
};

const create = async ({ full_name, dni, email, role }) => {
  // Validar DNI único
  if (await queries.findByDni(dni)) throw { status: 409, message: 'Ya existe un usuario registrado con ese DNI.' };
  if (await queries.findByEmail(email)) throw { status: 409, message: 'Ya existe un usuario registrado con ese email.' };

  const tempPassword   = generateTempPassword();
  const password_hash  = await bcrypt.hash(tempPassword, SALT_ROUNDS);
  const user           = await queries.create({ full_name, dni, email, password_hash, role });

  // La contraseña temporal se devuelve UNA SOLA VEZ para que el Admin la comunique
  return { user, tempPassword };
};

const update = async (id, data) => {
  const existing = await queries.findById(id);
  if (!existing) throw { status: 404, message: 'Usuario no encontrado.' };

  // Si cambia el DNI, verificar que no esté en uso
  if (data.dni && data.dni !== existing.dni) {
    const taken = await queries.findByDni(data.dni);
    if (taken && taken.id !== id) throw { status: 409, message: 'Ya existe un usuario registrado con ese DNI.' };
  }

  // Si cambia el rol de Admin a otro, verificar que quede al menos un Admin
  if (data.role && data.role !== 'ADMIN' && existing.role === 'ADMIN') {
    const admins = await queries.countActiveAdmins();
    if (admins <= 1) throw { status: 409, message: 'No es posible cambiar el rol del único administrador activo del sistema.' };
  }

  return queries.update(id, data);
};

const deactivate = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  if (user.status === 'INACTIVE') throw { status: 409, message: 'El usuario ya está inactivo.' };

  if (user.role === 'ADMIN') {
    const admins = await queries.countActiveAdmins();
    if (admins <= 1) throw { status: 409, message: 'No es posible desactivar el único administrador activo del sistema.' };
  }

  await queries.deactivate(id);
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
  await queries.resetPassword(id, password_hash);

  // Devuelve la contraseña temporal para que el Admin la comunique
  return { tempPassword };
};

const changePassword = async (id, currentPassword, newPassword) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };

  // Buscar el hash actual
  const full = await require('../../config/db').query(
    'SELECT password_hash FROM users WHERE id = $1', [id]
  );
  const valid = await bcrypt.compare(currentPassword, full.rows[0].password_hash);
  if (!valid) throw { status: 401, message: 'La contraseña actual es incorrecta.' };

  if (currentPassword === newPassword) throw { status: 400, message: 'La nueva contraseña no puede ser igual a la actual.' };

  const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await queries.changePassword(id, password_hash);
};

const unlock = async (id) => {
  const user = await queries.findById(id);
  if (!user) throw { status: 404, message: 'Usuario no encontrado.' };
  if (!user.locked_at) throw { status: 409, message: 'El usuario no está bloqueado.' };
  await queries.unlock(id);
};

module.exports = { getAll, getById, create, update, deactivate, activate, resetPassword, changePassword, unlock };
