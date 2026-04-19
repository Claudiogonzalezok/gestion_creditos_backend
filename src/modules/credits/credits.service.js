const pool        = require('../../config/db');
const queries     = require('./credits.queries');
const irQueries   = require('../interestRates/interestRates.queries');
const prQueries   = require('../productRates/productRates.queries');
const { getValue }= require('../systemConfig/systemConfig.queries');
const { withTransaction }    = require('../../utils/transaction');
const {
  getInstallmentAmount,
  getTotalWithInterest,
  getTotalToReturn,
  getDueDates,
  getWeekBounds,
  getProductInstallmentContribution,
} = require('../../utils/creditCalculator');

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

        // Verificar que exista tasa configurada para esta combinación
        const rateRecord = await prQueries.findActiveRate(
          p.id, data.payment_frequency, data.installments_count, client
        );
        if (!rateRecord)
          throw {
            status: 409,
            message: `No existe tasa configurada para "${p.name}" con ${data.installments_count} cuotas ${data.payment_frequency}.`,
          };

        computed += parseFloat(p.current_price) * item.quantity;
        productsWithPrice.push({ product_id: p.id, quantity: item.quantity, historical_price: p.current_price });
      }

      totalAmount = computed;

      // Validar down_payment si fue enviado
      const downPayment = parseFloat(data.down_payment || 0);
      if (downPayment >= totalAmount)
        throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };

      const credit = await queries.create(client, {
        customer_id:                     data.customer_id,
        created_by:                      requestingUser.id,
        type:                            data.type,
        total_amount:                    totalAmount,
        down_payment:                    downPayment,
        down_payment_method:             data.down_payment_method             || null,
        down_payment_transfer_reference: data.down_payment_transfer_reference || null,
        installments_count:              data.installments_count,
        payment_frequency:               data.payment_frequency,
        notes:                           data.notes,
      });

      await queries.createCreditProducts(client, credit.id, productsWithPrice);
      return credit;
    }

    // LOAN: total_amount viene directo del cuerpo del request; sin enganche
    return queries.create(client, {
      customer_id:        data.customer_id,
      created_by:         requestingUser.id,
      type:               data.type,
      total_amount:       totalAmount,
      down_payment:       0,
      installments_count: data.installments_count,
      payment_frequency:  data.payment_frequency,
      notes:              data.notes,
    });
  });
};

const simulate = async ({ type, total_amount, installments_count, payment_frequency, products }) => {
  // ── LOAN: tasa global por rango de monto (sin cambios) ────────
  if (type === 'LOAN') {
    const amount     = parseFloat(total_amount);
    const rateRecord = await irQueries.findActiveRate(payment_frequency, installments_count, amount);
    if (!rateRecord)
      throw { status: 404, message: 'No existe una tasa configurada para esta combinación y monto.' };

    const coef = parseFloat(rateRecord.rate);
    return {
      type,
      payment_frequency,
      installments_count,
      total_amount:       amount,
      installment_amount: getInstallmentAmount(amount, coef, installments_count),
      total_to_return:    getTotalToReturn(amount, coef, installments_count),
      note: 'Los valores son orientativos. La operación queda sujeta a aprobación.',
    };
  }

  // ── SALE: tasa por producto ───────────────────────────────────
  const items = [];
  let totalInstallment = 0;
  let totalBase        = 0;

  for (const item of products) {
    const prodRes = await pool.query(
      `SELECT id, name, current_price, status FROM products WHERE id = $1`, [item.product_id]
    );
    const p = prodRes.rows[0];
    if (!p) throw { status: 404, message: `Producto ${item.product_id} no encontrado.` };
    if (p.status !== 'ACTIVE')
      throw { status: 409, message: `El producto "${p.name}" no está disponible.` };

    const rateRecord = await prQueries.findActiveRate(p.id, payment_frequency, installments_count);
    if (!rateRecord)
      throw {
        status: 404,
        message: `No existe tasa configurada para "${p.name}" con ${installments_count} cuotas ${payment_frequency}.`,
      };

    const lineTotal      = parseFloat(p.current_price) * item.quantity;
    const coef           = parseFloat(rateRecord.rate);
    const contribution   = getProductInstallmentContribution(lineTotal, coef, installments_count);

    totalBase        += lineTotal;
    totalInstallment += contribution;

    items.push({
      product_id:              p.id,
      product_name:            p.name,
      quantity:                item.quantity,
      unit_price:              parseFloat(p.current_price),
      line_total:              lineTotal,
      rate:                    coef,
      installment_contribution: contribution,
    });
  }

  return {
    type,
    payment_frequency,
    installments_count,
    total_amount:       Math.round(totalBase * 100) / 100,
    installment_amount: totalInstallment,
    total_to_return:    totalInstallment * installments_count,
    items,
    note: 'Los valores son orientativos. La operación queda sujeta a aprobación.',
  };
};

const approve = async (id, adminId, newInstallmentsCount) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'PENDING_APPROVAL')
    throw { status: 409, message: 'Solo se pueden aprobar créditos en estado PENDIENTE DE APROBACIÓN.' };

  const installmentsCount  = newInstallmentsCount || credit.installments_count;
  const commissionRate     = parseFloat(await getValue('commission_rate') || '0.08');
  const { week_start, week_end } = getWeekBounds();

  // ── LOAN: tasa global por rango de monto ─────────────────────
  if (credit.type === 'LOAN') {
    const rateRecord = await irQueries.findActiveRate(credit.payment_frequency, installmentsCount, credit.total_amount);
    if (!rateRecord)
      throw { status: 409, message: 'No existe tasa de interés activa para esta combinación y monto.' };

    const installmentAmount = getInstallmentAmount(credit.total_amount, rateRecord.rate, installmentsCount);
    const dueDates          = getDueDates(new Date(), installmentsCount, credit.payment_frequency);

    await withTransaction(async (client) => {
      await queries.approve(client, id, adminId, rateRecord.rate, installmentsCount);
      await queries.generateInstallments(client, id, installmentAmount, dueDates, credit.payment_frequency);
    });

    return queries.findById(id);
  }

  // ── SALE: tasa por producto ───────────────────────────────────
  const creditProducts = await queries.findCreditProducts(id);
  const downPayment    = parseFloat(credit.down_payment || 0);
  const totalBase      = parseFloat(credit.total_amount); // precio bruto sin enganche
  // capitalRatio: fracción del precio que se financia en cuotas (1.0 si no hay enganche)
  const capitalRatio   = downPayment > 0 ? (totalBase - downPayment) / totalBase : 1;

  // Validar stock y calcular cuota por producto sobre el capital neto
  let totalInstallment = 0;
  const productRateMap = [];

  for (const p of creditProducts) {
    if (p.available_stock < p.quantity)
      throw {
        status: 409,
        message: `Stock insuficiente para "${p.name}". Disponible: ${p.available_stock}. Solicitadas: ${p.quantity}.`,
      };

    const rateRecord = await prQueries.findActiveRate(p.product_id, credit.payment_frequency, installmentsCount);
    if (!rateRecord)
      throw {
        status: 409,
        message: `No existe tasa configurada para "${p.name}" con ${installmentsCount} cuotas ${credit.payment_frequency}.`,
      };

    const lineTotal      = parseFloat(p.historical_price) * p.quantity;
    const netLine        = lineTotal * capitalRatio; // capital neto proporcional de este producto
    const contribution   = getProductInstallmentContribution(netLine, rateRecord.rate, installmentsCount);

    totalInstallment += contribution;
    productRateMap.push({
      creditProductId: p.id,
      productId:       p.product_id,
      rate:            rateRecord.rate,
      name:            p.name,
      quantity:        p.quantity,
    });
  }

  const dueDates = getDueDates(new Date(), installmentsCount, credit.payment_frequency);

  await withTransaction(async (client) => {
    // interest_rate = NULL en créditos SALE (los coeficientes viven en credit_products)
    await queries.approve(client, id, adminId, null, installmentsCount);

    // Congelar la tasa vigente en cada ítem del crédito
    for (const pr of productRateMap) {
      await queries.saveHistoricalRate(client, pr.creditProductId, pr.rate);
    }

    // Generar cuotas sobre el capital neto (precio − enganche)
    await queries.generateInstallments(client, id, totalInstallment, dueDates, credit.payment_frequency);

    // Descontar stock de cada producto
    for (const pr of productRateMap) {
      await queries.decrementProductStock(
        client, pr.productId, pr.quantity,
        `Venta a crédito aprobada — ID: ${id}`, adminId
      );
    }

    // Registrar enganche en caja (ya aprobado, sin flujo de cobrador)
    if (downPayment > 0) {
      await queries.createDownPayment(client, {
        creditId:          id,
        amount:            downPayment,
        paymentMethod:     credit.down_payment_method  || 'CASH',
        transferReference: credit.down_payment_transfer_reference || null,
        approvedBy:        adminId,
      });
    }

    // Comisión siempre sobre el total_amount bruto (el enganche no la reduce)
    if (credit.created_by) {
      const commissionAmount = credit.total_amount * commissionRate;
      await queries.createCommission(client, credit.created_by, id, commissionAmount, week_start, week_end);
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
