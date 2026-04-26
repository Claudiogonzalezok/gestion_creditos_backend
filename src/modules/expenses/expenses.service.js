const queries = require('./expenses.queries');

const getAll = async ({ dateFrom, dateTo, page, limit } = {}) => {
  return queries.findAll({ dateFrom, dateTo, page, limit });
};

const getById = async (id) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: 'Gasto no encontrado.' };
  return expense;
};

const create = async (data, requestingUser) => {
  return queries.create({
    amount:            parseFloat(data.amount),
    description:       data.description,
    paymentMethod:     data.payment_method,
    transferReference: data.transfer_reference || null,
    createdBy:         requestingUser.id,
  });
};

const remove = async (id) => {
  const expense = await queries.findById(id);
  if (!expense) throw { status: 404, message: 'Gasto no encontrado.' };

  const closed = await queries.hasCashRegister(expense.created_at);
  if (closed) throw { status: 409, message: 'No se puede eliminar un gasto que ya fue incluido en un cierre de caja.' };

  await queries.remove(id);
};

module.exports = { getAll, getById, create, remove };
