const queries  = require('./overdueNotice.queries');
const notifier = require('./notifier');
const companyQueries = require('../company/company.queries');
const { withTransaction } = require('../../utils/transaction');
const { localDate } = require('../../utils/date');

const COLLECTOR_ROLES = ['COLLECTOR', 'SELLER_COLLECTOR'];

/**
 * Formatea un monto en pesos (es-AR).
 * @param {number} n
 * @returns {string}
 */
const formatMoney = (n) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);

/**
 * Envía al cliente un aviso de mora de una cuota y lo registra.
 * Idempotente por cuota y día: un segundo pedido el mismo día no reenvía y
 * devuelve el aviso existente. Si el envío falla no queda registro (ROLLBACK),
 * así se puede reintentar.
 * @param {string} installmentId
 * @param {{id: string, role: string}} user - usuario autenticado
 * @returns {Promise<{already_notified: boolean, notice: object}>}
 */
const notifyOverdue = async (installmentId, user) => {
  if (!notifier.isConfigured()) throw notifier.notConfiguredError();
  const { system_name: companyName } = await companyQueries.getSettings();

  return withTransaction(async (client) => {
    const inst = await queries.findInstallmentForNotice(client, installmentId);
    if (!inst) throw { status: 404, message: 'Cuota no encontrada.' };

    if (COLLECTOR_ROLES.includes(user.role) && inst.assigned_collector_id !== user.id)
      throw { status: 403, message: 'Solo podés avisar a clientes asignados a vos.' };

    if (inst.status !== 'OVERDUE')
      throw { status: 409, code: 'INSTALLMENT_NOT_OVERDUE', message: 'La cuota no está en mora.' };

    if (!inst.customer_email)
      throw { status: 422, code: 'CUSTOMER_NO_EMAIL', message: 'El cliente no tiene email cargado.' };

    const today = localDate();
    const notice = await queries.insertNotice(client, {
      installmentId: inst.id,
      customerId: inst.customer_id,
      recipient: inst.customer_email,
      amountDue: inst.remaining,
      sentBy: user.id,
      notifiedOn: today,
    });
    if (!notice) {
      return { already_notified: true, notice: await queries.findNotice(client, inst.id, today) };
    }

    await notifier.send({
      to: inst.customer_email,
      subject: `${companyName}: cuota ${inst.installment_number} vencida`,
      text:
        `Hola ${inst.customer_name}:\n\n` +
        `Te recordamos que la cuota ${inst.installment_number} con vencimiento ${inst.due_date} ` +
        `está impaga. Saldo pendiente: ${formatMoney(inst.remaining)}.\n\n` +
        `Por favor regularizá tu situación o comunicate con ${companyName}.`,
    });
    return { already_notified: false, notice };
  });
};

module.exports = { notifyOverdue };
