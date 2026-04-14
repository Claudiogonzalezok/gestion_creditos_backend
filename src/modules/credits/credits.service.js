const pool        = require('../../config/db');
const queries     = require('./credits.queries');
const irQueries   = require('../interestRates/interestRates.queries');
const { getValue }= require('../systemConfig/systemConfig.queries');
const { withTransaction }    = require('../../utils/transaction');
const { getInstallmentAmount, getTotalWithInterest, getTotalToReturn, getDueDates, getWeekBounds } = require('../../utils/creditCalculator');

const getAll = async (filters, requestingUser) => {
  // SELLER solo ve los créditos que él mismo generó
  if (['SELLER','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, created_by: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  return credit;
};

const create = async (data, requestingUser) => {
  const customerCheck = await pool.query(
    `SELECT id, status FROM customers WHERE id = $1`, [data.customer_id]
  );
  if (!customerCheck.rows.length) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customerCheck.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede generar una operación para un cliente inactivo.' };

  if (data.type === 'SALE' && (!data.products || data.products.length === 0))
    throw { status: 400, message: 'Las ventas a crédito deben incluir al menos un producto.' };

  return withTransaction(async (client) => {
    let totalAmount = data.total_amount;

    if (data.type === 'SALE') {
      // Validar productos y calcular total_amount a partir del precio actual de cada uno
      const productsWithPrice = [];
      let computed = 0;

      for (const item of data.products) {
        const pRes = await client.query(
          `SELECT id, name, current_price, available_stock, status FROM products WHERE id = $1`,
          [item.product_id]
        );
        const p = pRes.rows[0];
        if (!p) throw { status: 404, message: `Producto ${item.product_id} no encontrado.` };
        if (p.status !== 'ACTIVE') throw { status: 409, message: `El producto "${p.name}" no está disponible.` };
        if (p.available_stock < item.quantity)
          throw { status: 409, message: `Stock insuficiente para "${p.name}". Disponible: ${p.available_stock}.` };

        computed += parseFloat(p.current_price) * item.quantity;
        productsWithPrice.push({ product_id: p.id, quantity: item.quantity, historical_price: p.current_price });
      }

      totalAmount = computed;

      const credit = await queries.create(client, {
        customer_id:        data.customer_id,
        created_by:         requestingUser.id,
        type:               data.type,
        total_amount:       totalAmount,
        installments_count: data.installments_count,
        payment_frequency:  data.payment_frequency,
        notes:              data.notes,
      });

      await queries.createCreditProducts(client, credit.id, productsWithPrice);
      return credit;
    }

    // LOAN: total_amount viene directo del cuerpo del request
    return queries.create(client, {
      customer_id:        data.customer_id,
      created_by:         requestingUser.id,
      type:               data.type,
      total_amount:       totalAmount,
      installments_count: data.installments_count,
      payment_frequency:  data.payment_frequency,
      notes:              data.notes,
    });
  });
};

const simulate = async ({ type, total_amount, installments_count, payment_frequency, products }) => {
  let amount = total_amount ? parseFloat(total_amount) : null;

  // Para SALE con productos: calcular total desde precios actuales
  if (type === 'SALE' && !amount && products?.length) {
    let computed = 0;
    for (const item of products) {
      const res = await pool.query(
        `SELECT current_price, status FROM products WHERE id = $1`, [item.product_id]
      );
      const p = res.rows[0];
      if (!p) throw { status: 404, message: `Producto ${item.product_id} no encontrado.` };
      if (p.status !== 'ACTIVE') throw { status: 409, message: `El producto ${item.product_id} no está disponible.` };
      computed += parseFloat(p.current_price) * item.quantity;
    }
    amount = computed;
  }

  const rateRecord = await irQueries.findActiveRate(payment_frequency, installments_count, amount);
  if (!rateRecord) throw { status: 404, message: 'No existe una tasa configurada para esta combinación y monto.' };

  const coef              = parseFloat(rateRecord.rate);
  const mathematicalTotal = getTotalWithInterest(amount, coef);
  const installmentAmount = getInstallmentAmount(amount, coef, installments_count);
  const totalToReturn     = getTotalToReturn(amount, coef, installments_count);
  const interestAmount    = Math.round((mathematicalTotal - amount) * 100) / 100;

  return {
    type,
    payment_frequency,
    installments_count,
    total_amount:       amount,
    installment_amount: installmentAmount,
    total_to_return:    totalToReturn,
    note: 'Los valores son orientativos. La operación queda sujeta a aprobación.',
  };
};

const approve = async (id, adminId, newInstallmentsCount) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'PENDING_APPROVAL')
    throw { status: 409, message: 'Solo se pueden aprobar créditos en estado PENDIENTE DE APROBACIÓN.' };

  const installmentsCount = newInstallmentsCount || credit.installments_count;
  const rateRecord = await irQueries.findActiveRate(credit.payment_frequency, installmentsCount, credit.total_amount);
  if (!rateRecord) throw { status: 409, message: 'No existe tasa de interés activa para esta combinación y monto.' };

  // Verificar stock antes de la transacción (solo SALE)
  let creditProducts = [];
  if (credit.type === 'SALE') {
    creditProducts = await queries.findCreditProducts(id);
    for (const p of creditProducts) {
      if (p.available_stock < p.quantity)
        throw { status: 409, message: `Stock insuficiente para "${p.name}". Disponible: ${p.available_stock}. Solicitadas: ${p.quantity}.` };
    }
  }

  const commissionRate     = parseFloat(await getValue('commission_rate') || '0.08');
  const { week_start, week_end } = getWeekBounds();

  await withTransaction(async (client) => {
    await queries.approve(client, id, adminId, rateRecord.rate, installmentsCount);

    const installmentAmount = getInstallmentAmount(credit.total_amount, rateRecord.rate, installmentsCount);
    const dueDates          = getDueDates(new Date(), installmentsCount, credit.payment_frequency);
    await queries.generateInstallments(client, id, installmentAmount, dueDates, credit.payment_frequency);

    if (credit.type === 'SALE') {
      for (const p of creditProducts) {
        await queries.decrementProductStock(
          client, p.product_id, p.quantity,
          `Venta a crédito aprobada — ID: ${id}`, adminId
        );
      }
      if (credit.created_by) {
        const commissionAmount = credit.total_amount * commissionRate;
        await queries.createCommission(client, credit.created_by, id, commissionAmount, week_start, week_end);
      }
    }
  });

  // Leemos DESPUÉS del COMMIT para reflejar el estado actualizado
  return queries.findById(id);
};

const reject = async (id, rejectionReason, adminId) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'PENDING_APPROVAL')
    throw { status: 409, message: 'Solo se pueden rechazar créditos en estado PENDIENTE DE APROBACIÓN.' };
  await queries.reject(id, rejectionReason, adminId);
};

const earlySettlement = async (id, paymentMethod, transferReference, adminId) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'ACTIVE')
    throw { status: 409, message: 'Solo se puede cancelar anticipadamente un crédito ACTIVO.' };

  const pendingInstallments = await queries.getPendingInstallments(id);
  if (!pendingInstallments.length)
    throw { status: 409, message: 'Este crédito no tiene cuotas pendientes.' };

  const settlementAmount = pendingInstallments.reduce((sum, inst) =>
    sum + parseFloat(inst.amount_due) - parseFloat(inst.amount_paid) + parseFloat(inst.penalty_amount), 0
  );

  const roundedSettlementAmount = Math.round(settlementAmount * 100) / 100;

  return withTransaction(async (client) => {
    await queries.settleAllInstallments(client, id);
    await client.query(
      `INSERT INTO payments
         (installment_id, collector_id, amount_received, payment_method, transfer_reference, status, approved_by, approved_at, notes)
       SELECT id, $1, amount_due, $2, $3, 'APPROVED', $1, NOW(), 'Cancelación anticipada'
       FROM installments WHERE credit_id = $4 AND installment_number = 1`,
      [adminId, paymentMethod, transferReference || null, id]
    );
    await client.query(
      `UPDATE credits
       SET status = 'SETTLED', settled_at = NOW(),
           settlement_amount = $1, settlement_type = 'EARLY_CANCELLATION', updated_at = NOW()
       WHERE id = $2`,
      [roundedSettlementAmount, id]
    );
    return { credit_id: id, settlement_amount: roundedSettlementAmount, payment_method: paymentMethod };
  });
};

module.exports = { getAll, getById, create, simulate, approve, reject, earlySettlement };
