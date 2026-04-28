const pool        = require('../../config/db');
const queries     = require('./credits.queries');
const irQueries   = require('../interestRates/interestRates.queries');
const prQueries   = require('../productRates/productRates.queries');
const puQueries   = require('../productUnits/productUnits.queries');
const { getValue }= require('../systemConfig/systemConfig.queries');
const { shiftInstallmentDates } = require('../payments/payments.queries');
const { withTransaction }       = require('../../utils/transaction');
const {
  getInstallmentAmount,
  getTotalToReturn,
  getDueDates,
  getWeekBounds,
  getProductInstallmentContribution,
} = require('../../utils/creditCalculator');

const sanitizeCredit = (credit) => {
  if (!credit) return credit;
  if (credit.type === 'LOAN') {
    delete credit.down_payment;
    delete credit.down_payment_method;
    delete credit.down_payment_transfer_reference;
    delete credit.prepaid_installments;
    delete credit.prepaid_installments_method;
    delete credit.prepaid_installments_transfer_reference;
  }
  if (credit.type === 'SALE') {
    delete credit.interest_rate;
  }
  return credit;
};

const getAll = async (filters, requestingUser) => {
  if (['SELLER','SELLER_COLLECTOR'].includes(requestingUser.role))
    filters = { ...filters, created_by: requestingUser.id };
  return queries.findAll(filters);
};

const getById = async (id) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  return sanitizeCredit(credit);
};

const create = async (data, requestingUser) => {
  const customerCheck = await pool.query(
    `SELECT id, status FROM customers WHERE id = $1`, [data.customer_id]
  );
  if (!customerCheck.rows.length) throw { status: 404, message: 'Cliente no encontrado.' };
  if (customerCheck.rows[0].status !== 'ACTIVE')
    throw { status: 409, message: 'No se puede generar una operación para un cliente inactivo.' };

  // ── LOAN ─────────────────────────────────────────────────────
  if (data.type === 'LOAN') {
    return withTransaction(async (client) => {
      const credit = await queries.create(client, {
        customer_id:        data.customer_id,
        created_by:         requestingUser.id,
        type:               'LOAN',
        total_amount:       data.total_amount,
        down_payment:       0,
        installments_count: data.installments_count,
        payment_frequency:  data.payment_frequency,
        notes:              data.notes,
      });
      delete credit.down_payment;
      delete credit.down_payment_method;
      delete credit.prepaid_installments;
      delete credit.prepaid_installments_method;
      return credit;
    });
  }

  // ── SALE: requiere unit_ids ───────────────────────────────────
  if (!data.unit_ids || data.unit_ids.length === 0)
    throw { status: 400, message: 'Las ventas a crédito deben incluir al menos una unidad de producto.' };

  return withTransaction(async (client) => {
    let totalAmount = 0;

    for (const unitId of data.unit_ids) {
      const unitRes = await client.query(
        `SELECT pu.id, pu.status, pu.product_id,
                p.current_price::float8, p.description, p.status AS product_status
         FROM product_units pu
         JOIN products p ON p.id = pu.product_id
         WHERE pu.id = $1`,
        [unitId]
      );
      const unit = unitRes.rows[0];
      if (!unit)
        throw { status: 404, message: `Unidad ${unitId} no encontrada.` };
      if (unit.product_status !== 'ACTIVE')
        throw { status: 409, message: `El producto "${unit.description}" no está activo.` };
      if (unit.status !== 'AVAILABLE')
        throw {
          status: 409,
          message: `La unidad "${unit.description}" (ID: ${unitId}) no está disponible (estado: ${unit.status}).`,
        };

      // Verificar que exista tasa para este producto
      const rateRecord = await prQueries.findActiveRate(
        unit.product_id, data.payment_frequency, data.installments_count, client
      );
      if (!rateRecord)
        throw {
          status: 409,
          message: `No existe tasa configurada para "${unit.description}" con ${data.installments_count} cuotas ${data.payment_frequency}.`,
        };

      totalAmount += unit.current_price;
    }

    const downPayment = parseFloat(data.down_payment || 0);
    if (downPayment >= totalAmount)
      throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };

    const prepaidInstallments = parseInt(data.prepaid_installments || 0);
    if (prepaidInstallments >= data.installments_count)
      throw { status: 400, message: 'El adelanto de cuotas no puede ser igual o mayor a la cantidad total de cuotas.' };

    const credit = await queries.create(client, {
      customer_id:                              data.customer_id,
      created_by:                               requestingUser.id,
      type:                                     'SALE',
      total_amount:                             totalAmount,
      down_payment:                             downPayment,
      down_payment_method:                      data.down_payment_method                      || null,
      down_payment_transfer_reference:          data.down_payment_transfer_reference          || null,
      prepaid_installments:                     prepaidInstallments,
      prepaid_installments_method:              data.prepaid_installments_method              || null,
      prepaid_installments_transfer_reference:  data.prepaid_installments_transfer_reference  || null,
      installments_count:                       data.installments_count,
      payment_frequency:                        data.payment_frequency,
      notes:                                    data.notes,
    });

    // Vincular unidades al crédito y marcarlas RESERVED
    for (const unitId of data.unit_ids) {
      const priceRes = await client.query(
        `SELECT p.current_price::float8
         FROM product_units pu JOIN products p ON p.id = pu.product_id
         WHERE pu.id = $1`,
        [unitId]
      );
      await queries.createCreditUnit(client, credit.id, unitId, priceRes.rows[0].current_price);
      await puQueries.updateStatus(client, unitId, 'RESERVED');
    }

    return credit;
  });
};

const simulate = async ({ type, total_amount, installments_count, payment_frequency, products, down_payment }) => {
  // ── LOAN ─────────────────────────────────────────────────────
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

  // ── SALE: recibe products [{product_id, quantity}] igual que antes ──────
  // La simulación usa product+quantity; la creación real usa unit_ids.
  const groups = [];
  let totalBase = 0;

  for (const item of products) {
    const prodRes = await pool.query(
      `SELECT id, description, current_price::float8, status FROM products WHERE id = $1`,
      [item.product_id]
    );
    const p = prodRes.rows[0];
    if (!p) throw { status: 404, message: `Producto ${item.product_id} no encontrado.` };
    if (p.status !== 'ACTIVE')
      throw { status: 409, message: `El producto "${p.description}" no está disponible.` };

    const rateRecord = await prQueries.findActiveRate(p.id, payment_frequency, installments_count);
    if (!rateRecord)
      throw {
        status: 404,
        message: `No existe tasa configurada para "${p.description}" con ${installments_count} cuotas ${payment_frequency}.`,
      };

    const lineTotal = p.current_price * item.quantity;
    totalBase += lineTotal;
    groups.push({ product_id: p.id, product_name: p.description, quantity: item.quantity, unit_price: p.current_price, line_total: lineTotal, rate: parseFloat(rateRecord.rate) });
  }

  const downPayment    = parseFloat(down_payment || 0);
  const financedAmount = downPayment > 0 ? totalBase - downPayment : totalBase;

  if (downPayment >= totalBase)
    throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };

  const capitalRatio = downPayment > 0 ? financedAmount / totalBase : 1;
  let totalInstallment = 0;

  for (const g of groups) {
    const netLine = g.line_total * capitalRatio;
    g.installment_contribution = getProductInstallmentContribution(netLine, g.rate, installments_count);
    totalInstallment += g.installment_contribution;
  }

  const result = {
    type,
    payment_frequency,
    installments_count,
    total_amount:       Math.round(totalBase * 100) / 100,
    installment_amount: totalInstallment,
    total_to_return:    Math.round((totalInstallment * installments_count + downPayment) * 100) / 100,
    items: groups,
    note: 'Los valores son orientativos. La operación queda sujeta a aprobación.',
  };

  if (downPayment > 0) {
    result.down_payment    = downPayment;
    result.financed_amount = Math.round(financedAmount * 100) / 100;
  }

  return result;
};

const approve = async (id, adminId, newInstallmentsCount) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'PENDING_APPROVAL')
    throw { status: 409, message: 'Solo se pueden aprobar créditos en estado PENDIENTE DE APROBACIÓN.' };

  const installmentsCount  = newInstallmentsCount || credit.installments_count;
  const commissionRate     = parseFloat(await getValue('commission_rate') || '0.08');
  const { week_start, week_end } = getWeekBounds();

  // ── LOAN ─────────────────────────────────────────────────────
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

    return sanitizeCredit(await queries.findById(id));
  }

  // ── SALE: aprobación por unidades ────────────────────────────
  const creditUnits = await queries.findCreditUnits(id);
  if (!creditUnits.length)
    throw { status: 409, message: 'El crédito no tiene unidades asociadas.' };

  const downPayment  = parseFloat(credit.down_payment || 0);
  const totalBase    = parseFloat(credit.total_amount);
  const capitalRatio = downPayment > 0 ? (totalBase - downPayment) / totalBase : 1;

  // Validar que todas las unidades siguen RESERVED para este crédito
  for (const u of creditUnits) {
    if (u.unit_status !== 'RESERVED')
      throw {
        status: 409,
        message: `La unidad del producto "${u.description}" ya no está disponible (estado: ${u.unit_status}).`,
      };
  }

  // Agrupar unidades por producto para calcular la cuota con el redondeo correcto
  const productGroups = new Map();
  for (const u of creditUnits) {
    if (!productGroups.has(u.product_id)) {
      const rateRecord = await prQueries.findActiveRate(u.product_id, credit.payment_frequency, installmentsCount);
      if (!rateRecord)
        throw {
          status: 409,
          message: `No existe tasa configurada para "${u.description}" con ${installmentsCount} cuotas ${credit.payment_frequency}.`,
        };
      productGroups.set(u.product_id, {
        rate:              parseFloat(rateRecord.rate),
        description:       u.description,
        lineTotal:         0,
        creditProductIds:  [],
      });
    }
    const g = productGroups.get(u.product_id);
    g.lineTotal += u.historical_price;
    g.creditProductIds.push(u.credit_product_id);
  }

  let totalInstallment = 0;
  for (const g of productGroups.values()) {
    const netLine = g.lineTotal * capitalRatio;
    totalInstallment += getProductInstallmentContribution(netLine, g.rate, installmentsCount);
  }

  const dueDates = getDueDates(new Date(), installmentsCount, credit.payment_frequency);

  await withTransaction(async (client) => {
    await queries.approve(client, id, adminId, null, installmentsCount);

    // Congelar tasa por unidad (mismo rate para todas las del mismo producto)
    for (const [, g] of productGroups) {
      for (const cpId of g.creditProductIds) {
        await queries.saveHistoricalRate(client, cpId, g.rate);
      }
    }

    await queries.generateInstallments(client, id, totalInstallment, dueDates, credit.payment_frequency);

    // Marcar cuotas adelantadas y registrar el pago
    if (credit.prepaid_installments > 0) {
      const n = credit.prepaid_installments;
      const prepaidTotal = await queries.markPrepaidInstallments(client, id, n);
      await queries.createDownPayment(client, {
        creditId:          id,
        amount:            prepaidTotal,
        paymentMethod:     credit.prepaid_installments_method,
        transferReference: credit.prepaid_installments_transfer_reference || null,
        approvedBy:        adminId,
        paymentType:       'PREPAID_INSTALLMENT',
      });
      await shiftInstallmentDates(client, id, credit.payment_frequency, dueDates[0]);
    }

    // Marcar unidades como SOLD
    const unitIds = creditUnits.map((u) => u.unit_id);
    await puQueries.updateStatusBulk(client, unitIds, 'SOLD');

    // Registrar enganche
    if (downPayment > 0) {
      await queries.createDownPayment(client, {
        creditId:          id,
        amount:            downPayment,
        paymentMethod:     credit.down_payment_method || 'CASH',
        transferReference: credit.down_payment_transfer_reference || null,
        approvedBy:        adminId,
      });
    }

    // Comisión sobre total bruto
    if (credit.created_by) {
      const commissionAmount = totalBase * commissionRate;
      await queries.createCommission(client, credit.created_by, id, commissionAmount, week_start, week_end);
    }
  });

  return sanitizeCredit(await queries.findById(id));
};

const reject = async (id, rejectionReason, adminId) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'PENDING_APPROVAL')
    throw { status: 409, message: 'Solo se pueden rechazar créditos en estado PENDIENTE DE APROBACIÓN.' };

  await withTransaction(async (client) => {
    // Liberar unidades RESERVED si es SALE
    if (credit.type === 'SALE') {
      const unitIds = await queries.findCreditUnitIds(id);
      if (unitIds.length) {
        await puQueries.updateStatusBulk(client, unitIds, 'AVAILABLE');
      }
    }
    await client.query(
      `UPDATE credits
       SET status = 'REJECTED', rejection_reason = $1, approved_by = $2,
           approved_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [rejectionReason, adminId, id]
    );
  });
};

const earlySettlement = async (id, paymentMethod, transferReference, adminId) => {
  const credit = await queries.findById(id);
  if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
  if (credit.status !== 'ACTIVE')
    throw { status: 409, message: 'Solo se puede cancelar anticipadamente un crédito ACTIVO.' };

  const pendingInstallments = await queries.getPendingInstallments(id);
  if (!pendingInstallments.length)
    throw { status: 409, message: 'Este crédito no tiene cuotas pendientes.' };

  const settlementAmount = pendingInstallments.reduce(
    (sum, inst) => sum + inst.amount_due - inst.amount_paid, 0
  );
  const roundedSettlementAmount = Math.round(settlementAmount * 100) / 100;
  const firstPendingId = pendingInstallments[0].id;

  return withTransaction(async (client) => {
    await queries.settleAllInstallments(client, id);
    await client.query(
      `INSERT INTO payments
         (installment_id, collector_id, amount_received, payment_method, transfer_reference,
          status, approved_by, approved_at, notes)
       VALUES ($1, $2, $3, $4, $5, 'APPROVED', $2, NOW(), 'Cancelación anticipada')`,
      [firstPendingId, adminId, roundedSettlementAmount, paymentMethod, transferReference || null]
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
