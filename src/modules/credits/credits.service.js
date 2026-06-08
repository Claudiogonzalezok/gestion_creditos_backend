const pool        = require('../../config/db');
const queries     = require('./credits.queries');
const irQueries   = require('../interestRates/interestRates.queries');
const prQueries   = require('../productRates/productRates.queries');
const puQueries   = require('../productUnits/productUnits.queries');
const { getValue }= require('../systemConfig/systemConfig.queries');
const { withTransaction } = require('../../utils/transaction');
const { localDate } = require('../../utils/date');
const businessDaysQueries = require('../businessDays/businessDays.queries');
const {
  getInstallmentAmount,
  getTotalToReturn,
  getDueDates,
  getDueDatesFromFirstPayment,
  adjustDueDatesWithBusinessDayRule,
  getWeekBounds,
  getProductInstallmentContribution,
} = require('../../utils/creditCalculator');
const {
  moveToNextBusinessDay,
  getActiveHolidayKeysInRange,
} = require('../../utils/businessDay');

/**
 * IMP-1: consulta business_days (autoridad post-rediseño). Cae al día actual
 * si no hay jornada abierta.
 */
const getActiveJornadaDate = async () => {
  const branch = await businessDaysQueries.findDefaultBranch();
  if (!branch) return localDate();
  const jornadaDate = await businessDaysQueries.findActiveJornadaDate(branch.id);
  return jornadaDate || localDate();
};

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
 * Convierte una fecha a formato YYYY-MM-DD para exponerla por API.
 * @param {Date} date - Fecha a serializar.
 * @returns {string} Fecha local simplificada.
 */
const toApiDate = (date) => localDate(date);

/**
 * Ajusta fechas de vencimiento al próximo día hábil según feriados activos y fines de semana.
 * @param {Date[]} baseDueDates - Fechas base calculadas por frecuencia.
 * @returns {Promise<Date[]>} Fechas ajustadas a calendario hábil.
 */
const applyBusinessDayRuleToDueDates = async (baseDueDates) => {
  if (!baseDueDates.length) return [];
  const holidayKeys = await getActiveHolidayKeysInRange(
    baseDueDates[0],
    new Date(baseDueDates[baseDueDates.length - 1].getTime() + (10 * 24 * 60 * 60 * 1000)),
  );
  return adjustDueDatesWithBusinessDayRule(
    baseDueDates,
    (date) => moveToNextBusinessDay(date, holidayKeys),
  );
};

/**
 * Arma un cronograma orientativo con capital, interés y saldo remanente.
 * @param {object} params - Parámetros de cálculo del plan.
 * @returns {Array<object>} Filas del cronograma para la UI.
 */
const buildSimulationSchedule = async ({
  financedAmount,
  installmentAmount,
  installmentsCount,
  paymentFrequency,
  firstPaymentDate,
  totalToReturn,
}) => {
  const count = parseInt(installmentsCount || 0);
  if (count <= 0 || installmentAmount <= 0) return [];

  const baseDueDates = getDueDatesFromFirstPayment(
    firstPaymentDate,
    count,
    paymentFrequency,
  );
  const dueDates = await applyBusinessDayRuleToDueDates(baseDueDates);
  const rawCapital = financedAmount / count;
  let remaining = totalToReturn;

  return dueDates.map((dueDate, index) => {
    const amount = installmentAmount;
    const capital = Math.round(rawCapital * 100) / 100;
    const interest = Math.max(0, Math.round((amount - capital) * 100) / 100);
    remaining = Math.max(0, Math.round((remaining - amount) * 100) / 100);

    return {
      installment_number: index + 1,
      due_date: toApiDate(dueDate),
      amount,
      capital,
      interest,
      remaining_estimated: remaining,
    };
  });
};

/**
 * Arma un cronograma consolidado de venta respetando la duración propia de cada línea.
 * @param {object} params - Parámetros del plan de venta.
 * @returns {Array<object>} Filas agregadas para la UI.
 */
const buildSaleSimulationSchedule = async ({
  groups,
  paymentFrequency,
  firstPaymentDate,
  installmentsCount,
}) => {
  const count = parseInt(installmentsCount || 0);
  if (count <= 0) return [];

  const baseDueDates = getDueDatesFromFirstPayment(
    firstPaymentDate,
    count,
    paymentFrequency,
  );
  const dueDates = await applyBusinessDayRuleToDueDates(baseDueDates);

  const rows = dueDates.map((dueDate, index) => {
    let amount = 0;
    let capital = 0;
    let interest = 0;

    for (const group of groups) {
      if (index >= group.installments_count) continue;
      const groupCapital = group.financed_line_total / group.installments_count;
      const groupInterest = Math.max(0, group.installment_contribution - groupCapital);
      amount += group.installment_contribution;
      capital += groupCapital;
      interest += groupInterest;
    }

    return {
      installment_number: index + 1,
      due_date: toApiDate(dueDate),
      amount: Math.round(amount * 100) / 100,
      capital: Math.round(capital * 100) / 100,
      interest: Math.round(interest * 100) / 100,
    };
  });

  let remaining = rows.reduce((acc, row) => acc + row.amount, 0);
  return rows.map((row) => {
    remaining = Math.max(0, Math.round((remaining - row.amount) * 100) / 100);
    return {
      ...row,
      remaining_estimated: remaining,
    };
  });
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
  const chain = await queries.getRefinancingChain(id);
  credit.refinancing_chain = chain;
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

  // Dedupe defensivo: si el frontend manda el mismo unitId dos veces, evita
  // que ambos pasen el SELECT FOR UPDATE (el lock no se bloquea contra la
  // misma tx) y el segundo intente reservar algo ya reservado por el primero.
  const uniqueUnitIds = [...new Set(data.unit_ids)];
  if (uniqueUnitIds.length !== data.unit_ids.length)
    throw { status: 400, message: 'No se pueden repetir unidades en una misma venta.' };

  return withTransaction(async (client) => {
    let totalAmount = 0;
    // Cache de precios durante la validación: se usa en la fase de reserva
    // sin re-consultar la DB, manteniendo consistencia con lo que se vio bajo
    // el lock.
    const priceByUnit = new Map();
    const titleByUnit = new Map();

    for (const unitId of uniqueUnitIds) {
      // SELECT FOR UPDATE OF pu: bloquea la fila de product_units hasta el
      // COMMIT/ROLLBACK. Cierra la TOCTOU entre la validación de AVAILABLE y
      // la transición a RESERVED. Dos requests concurrentes para la misma
      // unidad serializan: el segundo espera, y al leer ve el status ya
      // RESERVED por el primero → 409.
      const unitRes = await client.query(
        `SELECT pu.id, pu.status,
                pv.id AS variant_id, pv.current_price::float8, pv.product_id,
                pv.status AS variant_status,
                p.title, p.status AS product_status
         FROM product_units    pu
         JOIN product_variants pv ON pv.id = pu.variant_id
         JOIN products         p  ON p.id  = pv.product_id
         WHERE pu.id = $1
         FOR UPDATE OF pu`,
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
      priceByUnit.set(unitId, unit.current_price);
      titleByUnit.set(unitId, unit.title);
    }

    const downPayment = parseFloat(data.down_payment || 0);
    const prepaidInstallments = parseInt(data.prepaid_installments || 0, 10);
    if (downPayment >= totalAmount)
      throw { status: 400, message: 'El enganche no puede ser igual o mayor al monto total del crédito.' };
    if (prepaidInstallments >= data.installments_count)
      throw { status: 400, message: 'Las cuotas adelantadas deben ser menores a la cantidad total de cuotas.' };

    const credit = await queries.create(client, {
      customer_id:                              data.customer_id,
      created_by:                               requestingUser.id,
      type:                                     'SALE',
      total_amount:                             totalAmount,
      down_payment:                             downPayment,
      down_payment_method:                      data.down_payment_method                      || null,
      down_payment_transfer_reference:          data.down_payment_transfer_reference          || null,
      prepaid_installments:                     prepaidInstallments,
      prepaid_installments_method:              data.prepaid_installments_method             || null,
      prepaid_installments_transfer_reference:  data.prepaid_installments_transfer_reference || null,
      installments_count:                       data.installments_count,
      payment_frequency:                        data.payment_frequency,
      notes:                                    data.notes,
    });

    // Vincular unidades al crédito (precio congelado del SELECT bajo lock) y
    // hacer la transición AVAILABLE → RESERVED con guard SQL: si por alguna
    // razón la fila ya no está AVAILABLE, transitionStatus devuelve false y
    // abortamos con 409 (la transacción rollback libera todo lo previo).
    for (const unitId of uniqueUnitIds) {
      await queries.createCreditUnit(client, credit.id, unitId, priceByUnit.get(unitId));
      const reserved = await puQueries.transitionStatus(client, unitId, 'AVAILABLE', 'RESERVED');
      if (!reserved) {
        throw {
          status: 409,
          message: `La unidad "${titleByUnit.get(unitId)}" cambió de estado durante la operación. Reintentá la venta.`,
        };
      }
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
const simulate = async ({
  type,
  total_amount,
  installments_count,
  payment_frequency,
  products,
  down_payment,
  first_payment_date,
}) => {
  // ── LOAN ─────────────────────────────────────────────────────
  if (type === 'LOAN') {
    const amount     = parseFloat(total_amount);
    const rateRecord = await irQueries.findActiveRate(payment_frequency, installments_count, amount);
    if (!rateRecord)
      throw { status: 404, message: 'No existe una tasa configurada para esta combinación y monto.' };

    const coef = parseFloat(rateRecord.rate);
    const installmentAmount = getInstallmentAmount(amount, coef, installments_count);
    const totalToReturn = getTotalToReturn(amount, coef, installments_count);
    return {
      type,
      payment_frequency,
      installments_count,
      total_amount:       amount,
      rate:               coef,
      installment_amount: installmentAmount,
      total_to_return:    totalToReturn,
      interest_amount:    Math.max(0, Math.round((totalToReturn - amount) * 100) / 100),
      summary: {
        financed_amount: amount,
        down_payment: 0,
        interest_amount: Math.max(0, Math.round((totalToReturn - amount) * 100) / 100),
      },
      schedule: await buildSimulationSchedule({
        financedAmount: amount,
        installmentAmount,
        installmentsCount: installments_count,
        paymentFrequency: payment_frequency,
        firstPaymentDate: first_payment_date,
        totalToReturn,
      }),
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

    const lineInstallmentsCount = parseInt(item.installments_count || installments_count);
    const rateRecord = await prQueries.findActiveRate(v.product_id, payment_frequency, lineInstallmentsCount);
    if (!rateRecord)
      throw {
        status: 404,
        message: `No existe tasa configurada para "${v.title}" con ${lineInstallmentsCount} cuotas ${payment_frequency}.`,
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
      installments_count: lineInstallmentsCount,
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
    g.financed_line_total = Math.round(netLine * 100) / 100;
    g.installment_contribution = getProductInstallmentContribution(netLine, g.rate, g.installments_count);
    totalInstallment += g.installment_contribution;
  }

  const totalInstallmentsCount = Math.max(
    parseInt(installments_count || 0),
    ...groups.map((group) => parseInt(group.installments_count || 0)),
  );
  const financedAmountRounded = Math.round(financedAmount * 100) / 100;
  const schedule = await buildSaleSimulationSchedule({
    groups,
    installmentsCount: totalInstallmentsCount,
    paymentFrequency: payment_frequency,
    firstPaymentDate: first_payment_date,
  });
  const scheduledTotal = Math.round(
    schedule.reduce((acc, row) => acc + row.amount, 0) * 100,
  ) / 100;
  const totalToReturn = Math.round((scheduledTotal + downPayment) * 100) / 100;
  const interestAmount = Math.max(0, Math.round((totalToReturn - totalBase) * 100) / 100);

  const result = {
    type,
    payment_frequency,
    installments_count: totalInstallmentsCount,
    total_amount:       Math.round(totalBase * 100) / 100,
    installment_amount: totalInstallment,
    total_to_return:    totalToReturn,
    interest_amount:    interestAmount,
    summary: {
      financed_amount: financedAmountRounded,
      down_payment: downPayment,
      interest_amount: interestAmount,
    },
    schedule,
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
    const baseDueDates = getDueDates(new Date(), installmentsCount, credit.payment_frequency);
    const dueDates = await applyBusinessDayRuleToDueDates(baseDueDates);

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

  const baseDueDates = getDueDates(new Date(), installmentsCount, credit.payment_frequency);
  const dueDates = await applyBusinessDayRuleToDueDates(baseDueDates);
  const registerDate = await getActiveJornadaDate();

  // V4.3: si el crédito implica un movimiento de caja (downPayment o prepaid),
  // se imputa a la CAJA ACTIVA de la jornada (no a la caja del admin).
  const needsActiveSession = downPayment > 0 || credit.prepaid_installments > 0;

  await withTransaction(async (client) => {
    let activeCashSessionId = null;
    if (needsActiveSession) {
      const cashSessionsQueries = require('../cashSessions/cashSessions.queries');
      const activeSession = await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
      if (!activeSession)
        throw {
          status: 409,
          message: 'No hay caja operativa abierta. Abrí una caja para aprobar un crédito con enganche o cuotas adelantadas.',
          code: 'NO_ACTIVE_SESSION',
        };
      activeCashSessionId = activeSession.id;
    }

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
        registerDate,
        cashSessionId:     activeCashSessionId,
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
        registerDate,
        cashSessionId:     activeCashSessionId,
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
    // Si es una refinanciación rechazada, revertir el crédito original a ACTIVE
    // y restaurar sus cuotas al estado correcto según vencimiento y pagos parciales.
    if (credit.refinanced_from_credit_id) {
      const rejectedNote = `Refinanciación rechazada (${new Date().toLocaleDateString('es-AR')}): ${rejectionReason}`;
      await client.query(
        `UPDATE credits
         SET status            = 'ACTIVE',
             refinanced_at     = NULL,
             refinanced_by     = NULL,
             refinanced_reason = NULL,
             notes = CASE
               WHEN notes IS NULL THEN $2
               ELSE notes || ' | ' || $2
             END,
             updated_at = NOW()
         WHERE id = $1 AND status = 'REFINANCED'`,
        [credit.refinanced_from_credit_id, rejectedNote]
      );
      const graceDays = parseInt(await getValue('penalty_grace_days') || '3');
      await client.query(
        `UPDATE installments
         SET status = CASE
               WHEN due_date < CURRENT_DATE - ($1 * INTERVAL '1 day') THEN 'OVERDUE'
               WHEN amount_paid > 0                                    THEN 'PARTIAL'
               ELSE 'PENDING'
             END,
             updated_at = NOW()
         WHERE credit_id = $2
           AND status = 'REFINANCED'`,
        [graceDays, credit.refinanced_from_credit_id]
      );
    }
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

  // Validar que no haya pagos pendientes de aprobación
  const pendingPaymentsResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM payments p
     JOIN installments i ON i.id = p.installment_id
     WHERE i.credit_id = $1 AND p.status = 'PENDING'`,
    [id]
  );
  if (pendingPaymentsResult.rows[0].count > 0)
    throw {
      status: 409,
      message: 'El crédito tiene pagos pendientes de aprobación. Apruébalos o rechazalos antes de cancelar anticipadamente.',
    };

  const settlementAmount = Math.round(
    pendingInstallments.reduce((sum, inst) => sum + inst.amount_due - inst.amount_paid, 0) * 100
  ) / 100;

  return withTransaction(async (client) => {
    // Un payment por cuota para mantener trazabilidad completa en reportes y auditoría
    // Se crean en PENDING status para requerir aprobación explícita (doble aprobación)
    const paymentIds = [];
    for (const inst of pendingInstallments) {
      const instAmount = Math.round((inst.amount_due - inst.amount_paid) * 100) / 100;
      const paymentResult = await client.query(
        `INSERT INTO payments
           (installment_id, collector_id, amount_received, payment_method, transfer_reference,
            status, notes)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', 'Cancelación anticipada')
         RETURNING id`,
        [inst.id, adminId, instAmount, paymentMethod, transferReference || null]
      );
      paymentIds.push(paymentResult.rows[0].id);
    }

    // Store settlement info but keep credit ACTIVE until payments are approved
    // Once all payments are APPROVED, credit will be SETTLED via a separate process
    await client.query(
      `UPDATE credits
       SET settlement_amount = $1, settlement_type = 'EARLY_CANCELLATION',
           updated_at = NOW()
       WHERE id = $2`,
      [settlementAmount, id]
    );

    return {
      credit_id: id,
      settlement_amount: settlementAmount,
      payment_method: paymentMethod,
      payment_ids: paymentIds,
      message: 'Cancelación anticipada creada. Los pagos están pendientes de aprobación.'
    };
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

/**
 * Refinancia un crédito ACTIVE creando un nuevo crédito LOAN que absorbe el saldo pendiente.
 * El crédito original pasa a REFINANCED (deuda trasladada, no cancelada).
 *
 * Flujo atómico dentro de una transacción con FOR UPDATE:
 *   1. Lock del crédito original e installments
 *   2. Validaciones (estado, pagos pendientes, saldo)
 *   3. Crea nuevo crédito LOAN en PENDING_APPROVAL
 *   4. Marca original como REFINANCED
 *   5. Inserta registro en credit_refinancings
 *
 * El nuevo crédito debe ser aprobado normalmente mediante POST /credits/:id/approve.
 *
 * @param {string} creditId - ID del crédito a refinanciar.
 * @param {object} data - Parámetros de la refinanciación.
 * @param {number}  data.installments_count - Cantidad de cuotas del nuevo crédito.
 * @param {string}  data.payment_frequency  - Frecuencia del nuevo crédito.
 * @param {string}  data.reason             - Motivo obligatorio (mín. 5 caracteres).
 * @param {number}  [data.extra_charges]    - Cargos adicionales a sumar al saldo (default 0).
 * @param {string}  [data.notes]            - Notas opcionales para el nuevo crédito.
 * @param {string} adminId - ID del admin que ejecuta la operación.
 * @returns {Promise<object>} Nuevo crédito en PENDING_APPROVAL + info de la operación.
 */
const refinance = async (creditId, data, adminId) => {
  return withTransaction(async (client) => {
    // ── 1. Lock exclusivo: impide doble refinanciación y race conditions ─────
    const credit = await queries.lockCredit(client, creditId);
    if (!credit) throw { status: 404, message: 'Crédito no encontrado.' };
    if (credit.status !== 'ACTIVE')
      throw { status: 409, message: 'Solo se pueden refinanciar créditos en estado ACTIVO.' };

    // ── 2. Lock de cuotas + validación de saldo ──────────────────────────────
    const installments = await queries.lockInstallments(client, creditId);

    const pendingInstallments = installments.filter(
      (i) => ['PENDING', 'PARTIAL', 'OVERDUE'].includes(i.status),
    );
    if (!pendingInstallments.length)
      throw { status: 409, message: 'El crédito no tiene saldo pendiente para refinanciar.' };

    const pendingBalance = Math.round(
      pendingInstallments.reduce((sum, i) => sum + (i.amount_due - i.amount_paid), 0) * 100,
    ) / 100;

    // ── 3. Validación de pagos PENDING (cobros sin confirmar) ────────────────
    const hasPending = await queries.hasPendingPayments(client, creditId);
    if (hasPending)
      throw {
        status: 409,
        message: 'El crédito tiene cobros pendientes de aprobación. Resolvalos antes de refinanciar.',
      };

    // ── 4. Calcular monto total trasladado ───────────────────────────────────
    const extraCharges = Math.round(parseFloat(data.extra_charges || 0) * 100) / 100;
    if (extraCharges < 0) throw { status: 400, message: 'Los cargos adicionales no pueden ser negativos.' };
    const totalTransferred = Math.round((pendingBalance + extraCharges) * 100) / 100;

    // ── 5. Crear nuevo crédito LOAN en PENDING_APPROVAL ──────────────────────
    const newCredit = await queries.createRefinancing(client, {
      customer_id:              credit.customer_id,
      created_by:               adminId,
      total_amount:             totalTransferred,
      installments_count:       data.installments_count,
      payment_frequency:        data.payment_frequency,
      refinanced_from_credit_id: creditId,
      notes:                    data.notes || null,
    });

    // ── 6. Marcar crédito original como REFINANCED ───────────────────────────
    await queries.markAsRefinanced(client, creditId, adminId, data.reason);

    // ── 7. Registrar trazabilidad en credit_refinancings ────────────────────
    await queries.createRefinancingRecord(client, {
      original_credit_id: creditId,
      new_credit_id:      newCredit.id,
      pending_balance:    pendingBalance,
      extra_charges:      extraCharges,
      total_transferred:  totalTransferred,
      refinancing_type:   'STANDARD',
      reason:             data.reason,
      notes:              data.notes || null,
      executed_by:        adminId,
    });

    return {
      original_credit_id: creditId,
      new_credit:         newCredit,
      pending_balance:    pendingBalance,
      extra_charges:      extraCharges,
      total_transferred:  totalTransferred,
      message:            'Refinanciación creada. El nuevo crédito está pendiente de aprobación.',
    };
  });
};

module.exports = { getAll, getById, create, simulate, simulateAll, approve, reject, earlySettlement, refinance };
