const pool        = require('../../config/db');
const queries     = require('./credits.queries');
const irQueries   = require('../interestRates/interestRates.queries');
const prQueries   = require('../productRates/productRates.queries');
const puQueries   = require('../productUnits/productUnits.queries');
const { getValue }= require('../systemConfig/systemConfig.queries');
const { withTransaction } = require('../../utils/transaction');
const {
  getInstallmentAmount,
  getTotalToReturn,
  getDueDates,
  getWeekBounds,
  getProductInstallmentContribution,
} = require('../../utils/creditCalculator');

/**
 * Calcula el capital realmente financiado de una venta a crédito.
 * Mantiene separado el precio total del producto del enganche inicial.
 * @param {number|string} totalAmount - Precio total histórico de la venta.
 * @param {number|string} downPayment - Enganche entregado por el cliente.
 * @returns {number} Capital financiado neto.
 */
const getFinancedAmount = (totalAmount, downPayment = 0) => {
  const total = parseFloat(totalAmount || 0);
  const down  = parseFloat(downPayment || 0);
  return Math.round((total - down) * 100) / 100;
};

/**
 * Completa campos calculados de una venta para exponer capital financiado.
 * @param {object} credit - Crédito recuperado desde persistencia.
 * @returns {object|null} Crédito enriquecido para respuesta.
 */
const decorateSaleCredit = (credit) => {
  if (!credit || credit.type !== 'SALE') return credit;
  credit.financed_amount = getFinancedAmount(credit.total_amount, credit.down_payment);
  return credit;
};

/**
 * Elimina campos que no aplican al tipo de crédito y agrega derivados útiles.
 * @param {object} credit - Crédito a sanitizar antes de responder.
 * @returns {object|null} Crédito listo para exponer por API.
 */
const sanitizeCredit = (credit) => {
  if (!credit) return credit;
  if (credit.type === 'LOAN') {
    delete credit.down_payment;
    delete credit.down_payment_method;
    delete credit.down_payment_transfer_reference;
  }
  if (credit.type === 'SALE') {
    delete credit.interest_rate;
    delete credit.prepaid_installments;
    delete credit.prepaid_installments_method;
    delete credit.prepaid_installments_transfer_reference;
  }
  return decorateSaleCredit(credit);
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

/**
 * Crea una pre-operación de crédito respetando las reglas de LOAN y SALE.
 * En ventas conserva el precio total para comisión y calcula el capital financiado aparte.
 * @param {object} data - Datos validados de entrada.
 * @param {object} requestingUser - Usuario autenticado que origina la operación.
 * @returns {Promise<object>} Crédito pendiente listo para aprobación.
 */
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
      delete credit.down_payment_transfer_reference;
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
        `SELECT pu.id, pu.status,
                pv.id AS variant_id, pv.current_price::float8, pv.product_id,
                pv.status AS variant_status,
                p.title, p.status AS product_status
         FROM product_units    pu
         JOIN product_variants pv ON pv.id = pu.variant_id
         JOIN products         p  ON p.id  = pv.product_id
         WHERE pu.id = $1`,
        [unitId]
      );
      const unit = unitRes.rows[0];
      if (!unit)
        throw { status: 404, message: `Unidad ${unitId} no encontrada.` };
      if (unit.product_status !== 'ACTIVE')
        throw { status: 409, message: `El producto "${unit.title}" no está activo.` };
      if (unit.variant_status !== 'ACTIVE')
        throw { status: 409, message: `La variante del producto "${unit.title}" no está activa.` };
      if (unit.status !== 'AVAILABLE')
        throw {
          status: 409,
          message: `La unidad "${unit.title}" (ID: ${unitId}) no está disponible (estado: ${unit.status}).`,
        };

      // Verificar tasa para el producto padre de esta variante
      const rateRecord = await prQueries.findActiveRate(
        unit.product_id, data.payment_frequency, data.installments_count, client
      );
      if (!rateRecord)
        throw {
          status: 409,
          message: `No existe tasa configurada para "${unit.title}" con ${data.installments_count} cuotas ${data.payment_frequency}.`,
        };

      totalAmount += unit.current_price;
    }

    const downPayment = parseFloat(data.down_payment || 0);
    if (downPayment >= totalAmount)
      throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };

    const credit = await queries.create(client, {
      customer_id:                              data.customer_id,
      created_by:                               requestingUser.id,
      type:                                     'SALE',
      total_amount:                             totalAmount,
      down_payment:                             downPayment,
      down_payment_method:                      data.down_payment_method                      || null,
      down_payment_transfer_reference:          data.down_payment_transfer_reference          || null,
      prepaid_installments:                     0,
      prepaid_installments_method:              null,
      prepaid_installments_transfer_reference:  null,
      installments_count:                       data.installments_count,
      payment_frequency:                        data.payment_frequency,
      notes:                                    data.notes,
    });

    // Vincular unidades al crédito (precio de la variante) y marcarlas RESERVED
    for (const unitId of data.unit_ids) {
      const priceRes = await client.query(
        `SELECT pv.current_price::float8
         FROM product_units pu
         JOIN product_variants pv ON pv.id = pu.variant_id
         WHERE pu.id = $1`,
        [unitId]
      );
      await queries.createCreditUnit(client, credit.id, unitId, priceRes.rows[0].current_price);
      await puQueries.updateStatus(client, unitId, 'RESERVED');
    }

    return sanitizeCredit(credit);
  });
};

// simulate: SALE acepta products[{variant_id, quantity}]
/**
 * Simula el plan de cuotas según el tipo de operación y sus tasas vigentes.
 * Para SALE usa tasas por producto y muestra el capital financiado luego del enganche.
 * @param {object} params - Parámetros del cotizador.
 * @returns {Promise<object>} Resultado orientativo de la simulación.
 */
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

  // ── SALE: products[{variant_id, quantity}] ───────────────────
  const groups = [];
  let totalBase = 0;

  for (const item of products) {
    const varRes = await pool.query(
      `SELECT pv.id, pv.current_price::float8, pv.status AS variant_status,
              pv.color, pv.size, pv.capacity,
              p.id AS product_id, p.title, p.status AS product_status
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1`,
      [item.variant_id]
    );
    const v = varRes.rows[0];
    if (!v) throw { status: 404, message: `Variante ${item.variant_id} no encontrada.` };
    if (v.product_status !== 'ACTIVE')
      throw { status: 409, message: `El producto "${v.title}" no está disponible.` };
    if (v.variant_status !== 'ACTIVE')
      throw { status: 409, message: `La variante de "${v.title}" no está activa.` };

    const rateRecord = await prQueries.findActiveRate(v.product_id, payment_frequency, installments_count);
    if (!rateRecord)
      throw {
        status: 404,
        message: `No existe tasa configurada para "${v.title}" con ${installments_count} cuotas ${payment_frequency}.`,
      };

    const lineTotal = v.current_price * item.quantity;
    totalBase += lineTotal;
    groups.push({
      variant_id:   v.id,
      product_id:   v.product_id,
      product_name: v.title,
      color:        v.color,
      size:         v.size,
      capacity:     v.capacity,
      quantity:     item.quantity,
      unit_price:   v.current_price,
      line_total:   lineTotal,
      rate:         parseFloat(rateRecord.rate),
    });
  }

  const downPayment    = parseFloat(down_payment || 0);
  const financedAmount = getFinancedAmount(totalBase, downPayment);

  if (downPayment >= totalBase)
    throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };

  const capitalRatio   = downPayment > 0 ? financedAmount / totalBase : 1;
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

/**
 * Aprueba un crédito pendiente y congela sus condiciones históricas.
     * Para SALE toma product_rates por producto y registra enganches sin afectar la comisión.
     * El adelanto de cuotas posterior se procesa exclusivamente desde el módulo de cobros.
 * @param {string} id - ID del crédito.
 * @param {string} adminId - Admin que aprueba la operación.
 * @param {number} [newInstallmentsCount] - Nueva cantidad de cuotas opcional.
 * @returns {Promise<object>} Crédito aprobado con su estado actualizado.
 */
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

  // ── SALE ─────────────────────────────────────────────────────
  const creditUnits = await queries.findCreditUnits(id);
  if (!creditUnits.length)
    throw { status: 409, message: 'El crédito no tiene unidades asociadas.' };

  const downPayment    = parseFloat(credit.down_payment || 0);
  const totalBase      = parseFloat(credit.total_amount);
  const financedAmount = getFinancedAmount(totalBase, downPayment);
  const capitalRatio   = downPayment > 0 ? financedAmount / totalBase : 1;

  for (const u of creditUnits) {
    if (u.unit_status !== 'RESERVED')
      throw {
        status: 409,
        message: `La unidad del producto "${u.title}" ya no está disponible (estado: ${u.unit_status}).`,
      };
  }

  // Agrupar por product_id para buscar la tasa (la tasa es por producto, no por variante)
  const productGroups = new Map();
  for (const u of creditUnits) {
    if (!productGroups.has(u.product_id)) {
      const rateRecord = await prQueries.findActiveRate(u.product_id, credit.payment_frequency, installmentsCount);
      if (!rateRecord)
        throw {
          status: 409,
          message: `No existe tasa configurada para "${u.title}" con ${installmentsCount} cuotas ${credit.payment_frequency}.`,
        };
      productGroups.set(u.product_id, {
        rate:             parseFloat(rateRecord.rate),
        description:      u.title,
        lineTotal:        0,
        creditProductIds: [],
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

    for (const [, g] of productGroups) {
      for (const cpId of g.creditProductIds) {
        await queries.saveHistoricalRate(client, cpId, g.rate);
      }
    }

    await queries.generateInstallments(client, id, totalInstallment, dueDates, credit.payment_frequency);

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
      // No se llama shiftInstallmentDates: generateInstallments ya asignó fechas
      // correctas a todas las cuotas. Las N primeras quedan PAID; las restantes
      // conservan sus fechas originales sin necesidad de reasignación.
    }

    const unitIds = creditUnits.map((u) => u.unit_id);
    await puQueries.updateStatusBulk(client, unitIds, 'SOLD');

    if (downPayment > 0) {
      await queries.createDownPayment(client, {
        creditId:          id,
        amount:            downPayment,
        paymentMethod:     credit.down_payment_method || 'CASH',
        transferReference: credit.down_payment_transfer_reference || null,
        approvedBy:        adminId,
      });
    }

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
    if (credit.type === 'SALE') {
      const unitIds = await queries.findCreditUnitIds(id);
      if (unitIds.length) await puQueries.updateStatusBulk(client, unitIds, 'AVAILABLE');
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

  const settlementAmount = Math.round(
    pendingInstallments.reduce((sum, inst) => sum + inst.amount_due - inst.amount_paid, 0) * 100
  ) / 100;

  return withTransaction(async (client) => {
    await queries.settleAllInstallments(client, id);

    // Un payment por cuota para mantener trazabilidad completa en reportes y auditoría
    for (const inst of pendingInstallments) {
      const instAmount = Math.round((inst.amount_due - inst.amount_paid) * 100) / 100;
      await client.query(
        `INSERT INTO payments
           (installment_id, collector_id, amount_received, payment_method, transfer_reference,
            status, approved_by, approved_at, notes)
         VALUES ($1, $2, $3, $4, $5, 'APPROVED', $2, NOW(), 'Cancelación anticipada')`,
        [inst.id, adminId, instAmount, paymentMethod, transferReference || null]
      );
    }

    await client.query(
      `UPDATE credits
       SET status = 'SETTLED', settled_at = NOW(),
           settlement_amount = $1, settlement_type = 'EARLY_CANCELLATION', updated_at = NOW()
       WHERE id = $2`,
      [settlementAmount, id]
    );
    return { credit_id: id, settlement_amount: settlementAmount, payment_method: paymentMethod };
  });
};

/**
 * Calcula todas las combinaciones activas de cuotas/frecuencia para un monto o producto dado.
 * Omite silenciosamente las combinaciones sin tasa configurada.
 * @param {object} params
 * @param {string}   params.type         - 'LOAN' o 'SALE'.
 * @param {number}   [params.total_amount] - Monto (requerido para LOAN).
 * @param {object[]} [params.products]    - Variantes con cantidad (requerido para SALE).
 * @returns {Promise<object[]>} Array con los resultados de todas las simulaciones válidas.
 */
const simulateAll = async ({ type, total_amount, products }) => {
  if (type === 'LOAN') {
    const options = await irQueries.findActiveInstallmentOptions();
    const results = [];
    for (const [payment_frequency, installments_counts] of Object.entries(options)) {
      for (const installments_count of installments_counts) {
        try {
          const result = await simulate({ type, total_amount, installments_count, payment_frequency });
          results.push(result);
        } catch {
          // Sin tasa para esta combinación y monto — se omite
        }
      }
    }
    return results;
  }

  // ── SALE ─────────────────────────────────────────────────────
  const variantId = products[0].variant_id;
  const varRes = await pool.query(
    `SELECT pv.product_id, pv.status AS variant_status, p.status AS product_status
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE pv.id = $1`,
    [variantId]
  );
  if (!varRes.rows[0]) throw { status: 404, message: 'Variante no encontrada.' };
  if (varRes.rows[0].variant_status !== 'ACTIVE')
    throw { status: 409, message: 'La variante seleccionada no está disponible.' };
  if (varRes.rows[0].product_status !== 'ACTIVE')
    throw { status: 409, message: 'El producto seleccionado no está disponible.' };
  const productId = varRes.rows[0].product_id;

  const options = await prQueries.findActiveInstallmentOptionsForProduct(productId);
  const results = [];
  for (const [payment_frequency, installments_counts] of Object.entries(options)) {
    for (const installments_count of installments_counts) {
      try {
        const result = await simulate({ type, products, installments_count, payment_frequency });
        results.push(result);
      } catch {
        // Sin tasa para esta combinación — se omite
      }
    }
  }
  return results;
};

module.exports = { getAll, getById, create, simulate, simulateAll, approve, reject, earlySettlement };
