const pool = require("../../config/db");
const queries = require("./payments.queries");
const cashMovementsQueries = require("./cash_movements.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const businessDaysQueries = require("../businessDays/businessDays.queries");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");
const collectionsQueries = require("../collections/collections.queries");
const collectionAttemptsQueries = require("../collectionAttempts/collectionAttempts.queries");
const { getValue } = require("../systemConfig/systemConfig.queries");
const { withTransaction } = require("../../utils/transaction");
const notificationsService = require("../notifications/notifications.service");
const notificationsQueries = require("../notifications/notifications.queries");

/**
 * Hook: notifica a los admins activos que hay una nueva pre-carga de cobro
 * pendiente de aprobación (nace PENDING). Best-effort — un fallo de notify()
 * nunca debe afectar el resultado de la pre-carga ya persistida.
 * @param {object} payment - Pre-carga recién creada.
 */
const _notifyApprovalRequest = async (payment) => {
  try {
    const adminIds = await notificationsQueries.getActiveAdminUserIds();
    await notificationsService.notify({
      type: "APPROVAL_REQUEST",
      title: "Nueva solicitud de aprobación",
      message: `Se registró un cobro pendiente de aprobación por $${Number(payment.amount_received).toLocaleString("es-AR")} (ID: ${payment.id}).`,
      targetUserIds: adminIds,
      channels: ["push"],
      entityType: "payment",
      entityId: payment.id,
    });
  } catch (err) {
    console.error(
      "🔴  [notifications] Falló el hook de APPROVAL_REQUEST (pago):",
      err,
    );
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// NÚCLEO FINANCIERO REUTILIZABLE
// Funciones privadas compartidas por todos los flujos de cobranza.
// NO llamar directamente desde controllers — solo desde funciones de este módulo.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * IMP-1: valida que la jornada (business_day) de la fecha NO esté CLOSED/AUDITED.
 *
 * Autoridad post-rediseño: business_days. Reemplaza el check legacy contra
 * cash_registers.findByDate, que mantenía un sistema paralelo de cierre.
 *
 * NOTA: esta función valida UNA condición — la jornada mutable. La segunda
 * condición operativa (existe cash_session OPEN en la jornada) la valida cada
 * caller vía cashSessionsQueries.lockActiveSessionForCurrentJornada (V4).
 * No se duplica acá para no acoplar este check a la resolución de caja.
 *
 * @param {string} date - Fecha contable 'YYYY-MM-DD'.
 * @throws {{ status: 409, message }} si la jornada está CLOSED o AUDITED.
 */
const _validateCajaOpen = async (date) => {
  const branch = await businessDaysQueries.findDefaultBranch();
  if (!branch) return; // sin sucursales no hay nada que validar.
  const mutable = await businessDaysQueries.isJornadaMutable(date, branch.id);
  // Si la jornada NO existe (mutable=false por ausencia), permitir: la próxima
  // apertura de caja la creará. Solo bloqueamos si EXISTE y está terminal.
  if (mutable) return;

  // Re-consultar para distinguir "no existe" de "terminal".
  const r = await pool.query(
    `SELECT status FROM business_days WHERE business_date = $1::date AND branch_id = $2`,
    [date, branch.id],
  );
  if (!r.rows.length) return;
  throw {
    status: 409,
    message: `La jornada del ${date} ya está ${r.rows[0].status}. No es posible registrar cobros para ese día.`,
  };
};

const _round2 = (n) => Math.round(n * 100) / 100;

/**
 * Normaliza los montos de un cobro a un shape único, aceptando los dos formatos
 * de entrada que valida validators.js:
 *   · Mixto:  amount_cash / amount_transfer (efectivo + transferencia).
 *   · Legacy: amount_received + payment_method (un solo medio).
 *
 * `amountReceived` es siempre el TOTAL (efectivo + transferencia) — la lógica
 * financiera de distribución y saldos opera sobre ese valor sin enterarse del
 * desglose. `paymentMethod` queda en 'MIXED' cuando ambos medios son > 0.
 *
 * @param {object} data - Body del request ya validado.
 * @returns {{ amountReceived:number, amountCash:number, amountTransfer:number, paymentMethod:string }}
 */
const _normalizePaymentAmounts = (data) => {
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const mixedShape = has(data.amount_cash) || has(data.amount_transfer);

  if (mixedShape) {
    const amountCash = _round2(parseFloat(data.amount_cash) || 0);
    const amountTransfer = _round2(parseFloat(data.amount_transfer) || 0);
    const amountReceived = _round2(amountCash + amountTransfer);
    const paymentMethod =
      amountCash > 0 && amountTransfer > 0
        ? "MIXED"
        : amountTransfer > 0
          ? "TRANSFER"
          : "CASH";
    return { amountReceived, amountCash, amountTransfer, paymentMethod };
  }

  // Legacy: un solo medio. Todo el monto va a la columna del medio elegido.
  const amountReceived = _round2(parseFloat(data.amount_received));
  const paymentMethod = data.payment_method;
  return {
    amountReceived,
    amountCash: paymentMethod === "CASH" ? amountReceived : 0,
    amountTransfer: paymentMethod === "TRANSFER" ? amountReceived : 0,
    paymentMethod,
  };
};

// ── Núcleo de renovación (compartido por los dos caminos de pago) ─────────────
// Existe UNA sola operación de negocio RENEWAL, partida en dos primitivas puras
// que recorren cualquiera de los dos pipelines de pago (directo y pre-carga):
//   · _computeRenewalCharge: cálculo + validación ("cuánto y por qué").
//   · _applyRenewalEffects:  efectos sobre el préstamo cuando el pago se aprueba.

/**
 * Valida que el préstamo sea renovable y calcula el cargo de la renovación.
 * Compartido por el cobro directo (valida y cobra en el acto) y la pre-carga
 * (valida y congela el monto al crearse).
 *
 * Interés del período = importe CONGELADO de la cuota (capital + interés original)
 * − capital. Se usa original_amount, NO amount_due: applyPenalty suma la mora a
 * amount_due (invariante amount_due = original_amount + penalty_amount), así que
 * amount_due está contaminado por la mora. El interés se calcula siempre sobre el
 * interés original congelado en la operación, sin capitalización ni tasa nueva.
 * La mora manual acumulada se cobra junto con el interés (una sola vez).
 *
 * @param {object} loan - Fila de getRenewableLoan (crédito + cuota única).
 * @returns {{ interest:number, mora:number, total:number }} Desglose del cargo.
 * @throws {{ status:409, message }} si el préstamo no es renovable o no tiene interés.
 */
const _computeRenewalCharge = (loan) => {
  if (loan.type !== "LOAN" || loan.installments_count !== 1)
    throw {
      status: 409,
      message: "La renovación solo aplica a préstamos de una sola cuota.",
    };
  if (loan.credit_status !== "ACTIVE")
    throw {
      status: 409,
      message: `No se puede renovar un crédito en estado ${loan.credit_status}.`,
    };
  if (loan.installment_status === "PAID")
    throw {
      status: 409,
      message: "La cuota ya fue pagada; no se puede renovar.",
    };

  const frozenAmount =
    loan.original_amount != null
      ? loan.original_amount
      : loan.amount_due - (loan.penalty_amount || 0);
  const interest = _round2(frozenAmount - loan.total_amount);
  if (interest <= 0)
    throw { status: 409, message: "El préstamo no tiene interés a renovar." };
  const mora = _round2(loan.penalty_amount || 0);
  const total = _round2(interest + mora);
  return { interest, mora, total };
};

/**
 * Aplica los efectos de la renovación sobre el préstamo, en el momento en que el
 * pago queda APROBADO (cobro directo: de inmediato; pre-carga: al aprobar). Es la
 * segunda mitad de la operación RENEWAL, compartida por ambos caminos.
 *   · renewInstallment: corre el vencimiento un período (consecutivo desde el
 *     vencimiento anterior), resetea la mora (penalty_amount = 0) y restaura
 *     amount_due = original_amount, dejando la cuota como un préstamo nuevo.
 *   · anula la próxima visita agendada (queda obsoleta al correr el vencimiento).
 * NO aplica el pago a la cuota: el capital sigue debiéndose igual.
 *
 * @param {object} client - Cliente de transacción activa.
 * @param {string} installmentId - Cuota única del préstamo.
 * @param {string} paymentFrequency - Frecuencia del crédito.
 * @param {number} graceDays - Días de gracia (system_config).
 * @param {string} userId - Usuario que concreta la renovación (aprueba/cobra).
 */
const _applyRenewalEffects = async (
  client,
  installmentId,
  paymentFrequency,
  graceDays,
  userId,
) => {
  await queries.renewInstallment(
    client,
    installmentId,
    paymentFrequency,
    graceDays,
  );
  await collectionAttemptsQueries.voidScheduledVisitsForInstallment(
    client,
    installmentId,
    userId,
  );
};

/**
 * Distribuye el monto recibido sobre la cuota principal y cuotas siguientes si sobra saldo.
 * Toda la lógica financiera de distribución está centralizada aquí para reutilización.
 * Requiere un client con transacción activa.
 *
 * @param {object} client          - Cliente de transacción pg.
 * @param {object} payment         - Registro del payment con datos del cobro (installment_id,
 *                                   credit_id, payment_method, transfer_reference).
 *                                   Los campos amount_due/amount_paid/due_date que vengan acá
 *                                   son IGNORADOS — siempre se releen frescos bajo lock.
 * @param {number} amountToApply   - Monto total a distribuir.
 * @param {string} adminId         - ID del usuario que aprueba (para cuotas adelantadas).
 * @param {string|null} paymentId  - ID del cobro principal (para vincular sub-pagos vía parent_payment_id).
 * @param {number} graceDays       - Días de gracia para recálculo de status (de system_config).
 * @returns {Promise<void>}
 *
 * @throws {{ status: 409 }} si la cuota cambió de estado bajo lock (REFINANCED, PAID por
 *                            otro flujo concurrente). Defensa contra race conditions.
 */
const _applyPaymentToInstallments = async (
  client,
  payment,
  amountToApply,
  adminId,
  paymentId = null,
  graceDays = 0,
) => {
  // Lock + lectura FRESH de la cuota. Crítico: no confiar en payment.amount_due/paid
  // del JOIN previo en lockAndGetPayment — ese SELECT NO lockea la fila de installments,
  // y otra transacción concurrente puede haber modificado amount_paid entre el JOIN y
  // este punto. Releer bajo lock cierra esa race window.
  const freshInst = await queries.lockAndGetInstallment(
    client,
    payment.installment_id,
  );
  if (!freshInst) throw { status: 404, message: "Cuota no encontrada." };

  // Defensa contra race conditions: la cuota pudo haber cambiado de estado
  // entre la creación de la pre-carga y este lock.
  if (freshInst.status === "REFINANCED")
    throw {
      status: 409,
      message:
        "La cuota fue absorbida en una refinanciación. La pre-carga ya no es válida.",
    };
  if (freshInst.status === "PAID")
    throw {
      status: 409,
      message: "Esta cuota ya fue cancelada por otra operación concurrente.",
    };

  const amountDue = parseFloat(freshInst.amount_due);
  const amountPaid = parseFloat(freshInst.amount_paid);

  if (amountPaid >= amountDue)
    throw {
      status: 409,
      message: "Esta cuota ya fue cancelada por otra operación concurrente.",
    };

  const newInstStatus = await queries.updateInstallment(
    client,
    payment.installment_id,
    amountToApply,
    amountDue,
    amountPaid,
    graceDays,
  );

  const round = (n) => Math.round(n * 100) / 100;
  let remaining = round(amountToApply - (amountDue - amountPaid));
  let paidCount = 0;

  // Proporción efectivo/total del cobro cabecera. Las cuotas adelantadas heredan
  // esta mezcla para que su desglose por medio sea coherente con el cobro real.
  // Si el objeto payment no trae el desglose, se cae al payment_method (1 efectivo
  // / 0 transferencia) para mantener el comportamiento de un solo medio.
  const headerCash = parseFloat(payment.amount_cash) || 0;
  const headerTransfer = parseFloat(payment.amount_transfer) || 0;
  const headerTotal = headerCash + headerTransfer;
  const cashRatio =
    headerTotal > 0
      ? headerCash / headerTotal
      : payment.payment_method === "CASH"
        ? 1
        : 0;

  // Si sobra saldo y la cuota principal quedó PAID, distribuir a cuotas siguientes
  if (remaining > 0 && newInstStatus === "PAID") {
    const nextInstallments = await queries.getPendingInstallmentsFrom(
      client,
      freshInst.credit_id,
      freshInst.installment_number + 1,
    );

    for (const inst of nextInstallments) {
      if (remaining <= 0) break;

      const instBalance = round(
        parseFloat(inst.amount_due) - parseFloat(inst.amount_paid),
      );
      if (remaining >= instBalance) {
        await queries.markInstallmentAsPrepaid(
          client,
          inst.id,
          adminId,
          "Pago adelantado",
          payment.payment_method,
          payment.transfer_reference,
          paymentId,
          cashRatio,
        );
        remaining = round(remaining - instBalance);
        paidCount++;
      } else {
        await queries.updateInstallment(
          client,
          inst.id,
          remaining,
          parseFloat(inst.amount_due),
          parseFloat(inst.amount_paid),
          graceDays,
        );
        remaining = 0;
      }
    }
  }

  // Si se adelantaron cuotas completas, recorrer vencimientos de las restantes.
  // Usamos freshInst.due_date — refleja cualquier shift previo dentro de esta misma
  // transacción si lo hubo.
  if (paidCount > 0) {
    await queries.shiftInstallmentDates(
      client,
      freshInst.credit_id,
      freshInst.payment_frequency,
      freshInst.due_date,
    );
  }
};

/**
 * Verifica si el crédito quedó totalmente liquidado y lo marca como SETTLED.
 * Aplica SELECT FOR UPDATE sobre credits para evitar cierre doble en pagos concurrentes.
 * Respeta la lógica de mora del cron — no recalcula ni modifica penalty_amount.
 *
 * @param {object} client    - Cliente de transacción pg.
 * @param {string} creditId  - ID del crédito a verificar.
 */
const _checkAndSettleCredit = async (client, creditId) => {
  // Lock sobre el crédito antes de evaluar cierre para evitar race conditions
  const credit = await queries.lockAndGetCredit(client, creditId);
  if (!credit || credit.status === "SETTLED") return;

  const pendingCount = await queries.countPendingInstallments(client, creditId);
  if (pendingCount === 0) await queries.settleCredit(client, creditId);
};

/**
 * Registra el movimiento contable en cash_movements dentro de la transacción activa.
 * Debe ser la última operación antes del COMMIT para garantizar consistencia.
 *
 * @param {object} client
 * @param {object} params
 * @param {string} params.paymentId      - ID del payment que origina el movimiento.
 * @param {number} params.amount         - Monto positivo del movimiento.
 * @param {string} params.paymentMethod  - 'CASH' | 'TRANSFER'.
 * @param {string} params.movementType   - 'PAYMENT' | 'REVERSAL'.
 * @param {string} params.registerDate   - Fecha contable 'YYYY-MM-DD'.
 * @param {string} params.userId         - Usuario que ejecuta la operación.
 */
const _registerCashMovement = async (
  client,
  { paymentId, amount, paymentMethod, movementType, registerDate, userId },
) => {
  await cashMovementsQueries.create(client, {
    paymentId,
    amount,
    movementType,
    paymentMethod,
    registerDate,
    createdBy: userId,
  });
};

/**
 * Registra en caja el desglose de un cobro: un movimiento por cada medio con
 * monto > 0. Un cobro de un solo medio genera un único movimiento; uno mixto
 * genera dos (CASH y TRANSFER). cash_movements nunca recibe el pseudo-medio
 * 'MIXED' — siempre se desagrega a CASH/TRANSFER reales.
 *
 * @param {object} client
 * @param {object} params
 * @param {string} params.paymentId
 * @param {number} params.amountCash
 * @param {number} params.amountTransfer
 * @param {string} params.movementType - 'PAYMENT' | 'REVERSAL'.
 * @param {string} params.registerDate - Fecha contable 'YYYY-MM-DD'.
 * @param {string} params.userId
 */
const _registerSplitCashMovements = async (
  client,
  { paymentId, amountCash, amountTransfer, movementType, registerDate, userId },
) => {
  const cash = parseFloat(amountCash) || 0;
  const transfer = parseFloat(amountTransfer) || 0;
  if (cash > 0) {
    await _registerCashMovement(client, {
      paymentId,
      amount: cash,
      paymentMethod: "CASH",
      movementType,
      registerDate,
      userId,
    });
  }
  if (transfer > 0) {
    await _registerCashMovement(client, {
      paymentId,
      amount: transfer,
      paymentMethod: "TRANSFER",
      movementType,
      registerDate,
      userId,
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA DEL SERVICIO
// ══════════════════════════════════════════════════════════════════════════════

const getAll = async (filters, requestingUser) => {
  if (["COLLECTOR", "SELLER_COLLECTOR"].includes(requestingUser.role))
    filters = { ...filters, collector_id: requestingUser.id };
  return queries.findAll(filters);
};

/**
 * Devuelve un cobro por ID. Para cobradores (no admin), solo retorna cobros
 * propios — alinea el comportamiento con getAll (que también filtra por
 * collector_id). Sin este filtro, un cobrador podía leer cobros ajenos
 * conociendo el UUID, lo que filtraba info de clientes de otros cobradores.
 *
 * Retorna 404 si el cobro pertenece a otro cobrador, para no filtrar la
 * existencia del recurso.
 */
const getById = async (id, requestingUser) => {
  const payment = await queries.findById(id);
  if (!payment) throw { status: 404, message: "Cobro no encontrado." };

  if (
    ["COLLECTOR", "SELLER_COLLECTOR"].includes(requestingUser.role) &&
    payment.collector_id !== requestingUser.id
  ) {
    throw { status: 404, message: "Cobro no encontrado." };
  }
  return payment;
};

/**
 * Registra una pre-carga de cobro validando el saldo disponible del crédito.
 * Permite montos que cubran varias cuotas siempre que no superen el saldo pendiente total.
 * @param {object} data - Datos validados del cobro.
 * @param {object} requestingUser - Cobrador autenticado que registra la pre-carga.
 * @returns {Promise<object>} Pre-carga creada en estado pendiente.
 */
const create = async (data, requestingUser) => {
  const instCheck = await pool.query(
    `SELECT id, status, amount_due::float8, amount_paid::float8, credit_id FROM installments WHERE id = $1`,
    [data.installment_id],
  );
  if (!instCheck.rows.length)
    throw { status: 404, message: "Cuota no encontrada." };
  const inst = instCheck.rows[0];
  if (inst.status === "PAID")
    throw { status: 409, message: "Esta cuota ya fue pagada." };

  const creditInfo = await queries.getCreditStatusByInstallment(
    data.installment_id,
  );
  if (creditInfo && creditInfo.status !== "ACTIVE")
    throw {
      status: 409,
      message: `No se pueden registrar cobros en un crédito en estado ${creditInfo.status}.`,
    };

  const amountDue = inst.amount_due;
  const amountPaid = inst.amount_paid;
  const pendingAmount = await queries.getPendingCommittedAmount(
    data.installment_id,
  );
  const available = amountDue - amountPaid - pendingAmount;

  if (available <= 0)
    throw {
      status: 409,
      message:
        "Esta cuota ya tiene pre-cargas pendientes que cubren el saldo total.",
    };

  const amounts = _normalizePaymentAmounts(data);
  const amountReceived = amounts.amountReceived;

  // Si amount_received no cubre el saldo restante, la cuota quedará PARTIAL → next_visit_date obligatorio.
  // EDGE CASE documentado (ETAPA 2): si el monto cubre la cuota actual pero redistribuye a cuotas
  // siguientes, la cuota podría quedar PAID. La validación 100% exacta requeriría un dry-run de
  // _applyPaymentToInstallments. Se acepta este comportamiento conservador para ETAPA 1.
  const remainingBalance = amountDue - amountPaid;
  if (amountReceived < remainingBalance && !data.next_visit_date)
    throw {
      status: 422,
      message:
        "La fecha de próxima visita es obligatoria para cobros parciales.",
    };

  if (amountReceived > available) {
    const totalPending = await queries.getTotalPendingBalance(inst.credit_id);
    if (amountReceived > totalPending)
      throw {
        status: 422,
        message: `El monto ingresado ($${amountReceived.toLocaleString("es-AR")}) supera el saldo total pendiente del crédito ($${totalPending.toLocaleString("es-AR")}).`,
      };
  }

  // V4.2: la pre-carga NO requiere caja abierta. El cobrador es un actor de
  // campo, no opera caja. `cash_session_id` queda NULL hasta que el admin
  // apruebe (en `approve` se imputa a la caja activa de la jornada, V4.3).
  // Se eliminó el wrap withTransaction de IMP-2 porque ya no hay lock de
  // caja que proteger en este flujo — el INSERT del payment y el hook de
  // management_status son operaciones independientes; un fallo del hook no
  // debe revertir el payment (es un side-effect de UI, no contable).
  const payment = await queries.create({
    installment_id: data.installment_id,
    collector_id: requestingUser.id,
    amount_received: amounts.amountReceived,
    amount_cash: amounts.amountCash,
    amount_transfer: amounts.amountTransfer,
    payment_method: amounts.paymentMethod,
    transfer_reference: data.transfer_reference,
    notes: data.notes,
    next_visit_date: data.next_visit_date,
    cash_session_id: null, // V4.2: se llena en approve.
  });

  // Hook: notificar a los admins que hay una nueva pre-carga pendiente de
  // aprobación. Post-creación, best-effort — nunca afecta el resultado del
  // payment ya persistido.
  await _notifyApprovalRequest(payment);

  // Hook: el cobrador estuvo en el domicilio y dejó pre-carga → VISITED.
  // approve cambiará a PAID si la cuota queda saldada, o quedará VISITED
  // si fue pago parcial. Si el hook falla, el payment ya está persistido —
  // es aceptable (la planilla puede recomputarse manualmente).
  await collectionsQueries.updateManagementStatusForActiveTodaySheet(
    requestingUser.id,
    data.installment_id,
    "VISITED",
  );

  return payment;
};

/**
 * Aprueba una pre-carga y distribuye el monto sobre cuotas futuras si hay excedente.
 * Valida que la caja del día esté abierta antes de procesar.
 * Usa SELECT FOR UPDATE sobre el payment e installment para evitar aprobaciones concurrentes.
 *
 * CAMBIOS DE CONTRATO API: ninguno — misma firma, misma respuesta.
 * Comportamiento nuevo:
 *   · Valida caja abierta (lanza 409 si la caja del día fue cerrada).
 *   · Genera registro en cash_movements dentro de la misma transacción.
 *   · Usa locks transaccionales para serializar aprobaciones simultáneas.
 *
 * @param {string} id      - ID de la pre-carga.
 * @param {string} adminId - Admin que valida el cobro.
 * @returns {Promise<object>} Cobro aprobado con su estado actualizado.
 */
const approve = async (id, adminId) => {
  const jornadaDate = await getActiveJornadaDate();

  // Validar caja ANTES de iniciar la transacción (operación de solo lectura)
  await _validateCajaOpen(jornadaDate);

  // Días de gracia para el recálculo de status post-aplicación del pago
  const graceDays = parseInt((await getValue("penalty_grace_days")) || "3");

  await withTransaction(async (client) => {
    // V4: resolver la caja activa de la jornada actual bajo lock. Si no hay
    // caja operativa abierta, el dinero no tiene dónde imputarse → 409.
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession) {
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para aprobar cobros.",
        code: "NO_ACTIVE_SESSION",
      };
    }

    // Lock exclusivo sobre el payment para serializar aprobaciones concurrentes
    const payment = await queries.lockAndGetPayment(client, id);
    if (!payment) throw { status: 404, message: "Cobro no encontrado." };
    if (payment.status !== "PENDING")
      throw {
        status: 409,
        message: "Solo se pueden aprobar cobros en estado PENDIENTE.",
      };

    const amountDue = parseFloat(payment.amount_due);
    const amountPaid = parseFloat(payment.amount_paid);

    if (amountPaid >= amountDue)
      throw {
        status: 409,
        message: "Esta cuota ya se encuentra totalmente pagada.",
      };

    // 1. Marcar el payment como APPROVED + imputar a la caja activa de la jornada.
    await queries.approve(client, id, adminId, activeSession.id);

    // 2. Distribuir el monto sobre la cuota principal y siguientes si hay excedente
    await _applyPaymentToInstallments(
      client,
      payment,
      parseFloat(payment.amount_received),
      adminId,
      id,
      graceDays,
    );

    // 3. Registrar movimiento(s) contable(s) en caja — uno por medio con monto > 0.
    //    Se usa la fecha de la jornada activa, no localDate(), para que los cobros
    //    post-medianoche queden en la jornada correcta.
    await _registerSplitCashMovements(client, {
      paymentId: id,
      amountCash: payment.amount_cash,
      amountTransfer: payment.amount_transfer,
      movementType: "PAYMENT",
      registerDate: jornadaDate,
      userId: adminId,
    });

    // 4. Verificar si el crédito quedó totalmente liquidado (con lock sobre credits)
    await _checkAndSettleCredit(client, payment.credit_id);

    // 5. Hook: reflejar el resultado en la planilla del día del cobrador.
    // Si la cuota quedó PAID, marcamos PAID; si quedó parcial, VISITED.
    // Se ejecuta DENTRO de la transacción: si el trigger DB rechazara,
    // el approve completo rollback (defensa contra race sheet ACTIVE→CLOSED).
    const instAfter = await client.query(
      `SELECT status FROM installments WHERE id = $1`,
      [payment.installment_id],
    );
    const newMgmtStatus =
      instAfter.rows[0]?.status === "PAID" ? "PAID" : "VISITED";
    await collectionsQueries.updateManagementStatusForActiveTodaySheet(
      payment.collector_id,
      payment.installment_id,
      newMgmtStatus,
      client,
    );
  });

  return queries.findById(id);
};

/**
 * Rechaza una pre-carga. No genera movimiento de caja.
 *
 * Usa lockAndGetPayment + SQL guard en el UPDATE para evitar la race con un
 * approve concurrente: si entre el check inicial y el UPDATE otro admin
 * aprobó el mismo cobro, el guard (WHERE status='PENDING') previene que
 * se sobrescriba el APPROVED a REJECTED.
 *
 * @param {string} id              - ID de la pre-carga.
 * @param {string} rejectionReason - Motivo del rechazo.
 * @param {string} adminId         - Admin que rechaza.
 */
const reject = async (id, rejectionReason, adminId) => {
  await withTransaction(async (client) => {
    const payment = await queries.lockAndGetPayment(client, id);
    if (!payment) throw { status: 404, message: "Cobro no encontrado." };
    if (payment.status !== "PENDING")
      throw {
        status: 409,
        message: "Solo se pueden rechazar cobros en estado PENDIENTE.",
      };

    const rejected = await queries.reject(client, id, rejectionReason, adminId);
    // Defensa adicional: si el SQL guard no actualizó (status cambió bajo lock,
    // caso teóricamente imposible con el lock pero defensivo), lanzamos 409.
    if (!rejected)
      throw {
        status: 409,
        message: "El cobro cambió de estado durante la operación. Reintentá.",
      };
  });
};

/**
 * Devuelve el historial de pagos aprobados de un crédito.
 * @param {string} creditId
 */
const getByCredit = async (creditId) => {
  return queries.findPaymentsByCredit(creditId);
};

/**
 * Registra y aprueba un cobro directo sin pre-carga (flujo admin).
 * Valida caja abierta, crea el payment como APPROVED y distribuye el monto.
 *
 * @param {object} data
 * @param {string} data.installment_id
 * @param {number} data.amount_received
 * @param {string} data.payment_method
 * @param {string} [data.transfer_reference]
 * @param {string} [data.notes]
 * @param {string} adminId
 * @returns {Promise<object>} Payment creado y aprobado.
 */
const adminDirect = async (data, adminId) => {
  const jornadaDate = await getActiveJornadaDate();
  await _validateCajaOpen(jornadaDate);

  // V4.3: la caja activa se resuelve bajo lock dentro de la tx vía
  // lockActiveSessionForCurrentJornada (no más por owner).

  // Días de gracia para el recálculo de status post-aplicación del pago
  const graceDays = parseInt((await getValue("penalty_grace_days")) || "3");

  // Validar cuota
  const instCheck = await pool.query(
    `SELECT id, status, amount_due::float8, amount_paid::float8, credit_id,
            installment_number
     FROM installments WHERE id = $1`,
    [data.installment_id],
  );
  if (!instCheck.rows.length)
    throw { status: 404, message: "Cuota no encontrada." };
  const inst = instCheck.rows[0];
  if (inst.status === "PAID")
    throw { status: 409, message: "Esta cuota ya fue pagada." };

  // Validar que el crédito esté ACTIVE — no se puede cobrar sobre créditos liquidados o rechazados
  const creditInfo = await queries.getCreditStatusByInstallment(
    data.installment_id,
  );
  if (creditInfo && creditInfo.status === "SETTLED")
    throw {
      status: 409,
      message:
        "Este crédito ya fue liquidado totalmente. No es posible registrar cobros.",
    };
  if (creditInfo && !["ACTIVE"].includes(creditInfo.status))
    throw {
      status: 409,
      message: `No se pueden registrar cobros en un crédito en estado ${creditInfo.status}.`,
    };

  const amounts = _normalizePaymentAmounts(data);
  const amountReceived = amounts.amountReceived;
  const totalPending = await queries.getTotalPendingBalance(inst.credit_id);
  if (amountReceived > totalPending)
    throw {
      status: 422,
      message: `El monto ingresado ($${amountReceived.toLocaleString("es-AR")}) supera el saldo total pendiente del crédito ($${totalPending.toLocaleString("es-AR")}).`,
    };

  let newPaymentId;
  await withTransaction(async (client) => {
    // V4.3: imputar a la caja activa de la jornada (no al admin).
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession)
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para registrar un cobro directo.",
        code: "NO_ACTIVE_SESSION",
      };

    // Lock sobre la cuota principal
    const lockedInst = await queries.lockAndGetInstallment(
      client,
      data.installment_id,
    );
    if (!lockedInst) throw { status: 404, message: "Cuota no encontrada." };
    if (lockedInst.status === "PAID")
      throw { status: 409, message: "Esta cuota ya fue pagada." };

    const created = await queries.createApproved(client, {
      installmentId: data.installment_id,
      adminId,
      amountReceived,
      amountCash: amounts.amountCash,
      amountTransfer: amounts.amountTransfer,
      paymentMethod: amounts.paymentMethod,
      transferReference: data.transfer_reference,
      notes: data.notes,
      cashSessionId: activeSession.id,
    });
    newPaymentId = created.id;

    // Construir objeto payment compatible con _applyPaymentToInstallments
    const paymentCtx = {
      installment_id: lockedInst.id,
      installment_number: lockedInst.installment_number,
      amount_due: lockedInst.amount_due,
      amount_paid: lockedInst.amount_paid,
      credit_id: lockedInst.credit_id,
      payment_frequency: lockedInst.payment_frequency,
      due_date: lockedInst.due_date,
      payment_method: amounts.paymentMethod,
      amount_cash: amounts.amountCash,
      amount_transfer: amounts.amountTransfer,
      transfer_reference: data.transfer_reference || null,
    };

    await _applyPaymentToInstallments(
      client,
      paymentCtx,
      amountReceived,
      adminId,
      newPaymentId,
      graceDays,
    );

    // Movimiento(s) de caja: uno por medio con monto > 0 (split mixto).
    await _registerSplitCashMovements(client, {
      paymentId: newPaymentId,
      amountCash: amounts.amountCash,
      amountTransfer: amounts.amountTransfer,
      movementType: "PAYMENT",
      registerDate: jornadaDate,
      userId: adminId,
    });

    await _checkAndSettleCredit(client, lockedInst.credit_id);
  });

  return queries.findById(newPaymentId);
};

/**
 * Renueva un préstamo LOAN de una sola cuota: el cliente paga solo el interés del
 * período para extender el vencimiento. Es un caso particular del cobro directo —
 * reutiliza los mismos primitivos (createApproved + registro en caja) — pero NO
 * aplica el pago a la cuota (el capital sigue debiéndose) y, en su lugar, corre el
 * vencimiento un período. El pago se etiqueta generation_type='RENEWAL'.
 *
 * @param {string} creditId - Préstamo a renovar.
 * @param {object} data - Medio de pago del interés (payment_method + split mixto).
 * @param {string} adminId - Admin que registra la renovación.
 * @returns {Promise<object>} El pago de renovación creado.
 */
const renew = async (creditId, data, adminId) => {
  const jornadaDate = await getActiveJornadaDate();
  await _validateCajaOpen(jornadaDate);
  const graceDays = parseInt((await getValue("penalty_grace_days")) || "3");

  const loan = await queries.getRenewableLoan(creditId);
  if (!loan) throw { status: 404, message: "Crédito no encontrado." };

  // Núcleo de renovación compartido: valida que sea renovable y calcula el cargo
  // (interés congelado + mora). Misma lógica que recorre la pre-carga.
  const { interest, mora, total: totalToCharge } = _computeRenewalCharge(loan);

  // El monto SIEMPRE es el total a cobrar (fijo). Se reutiliza el normalizador de
  // montos: para un solo medio se imputa todo el total; en mixto, el split debe
  // sumar exactamente el total (interés + mora).
  const amounts =
    data.payment_method === "MIXED"
      ? _normalizePaymentAmounts({
          amount_cash: data.amount_cash,
          amount_transfer: data.amount_transfer,
        })
      : _normalizePaymentAmounts({
          amount_received: totalToCharge,
          payment_method: data.payment_method,
        });
  if (_round2(amounts.amountReceived) !== totalToCharge)
    throw {
      status: 422,
      message: `El monto debe ser exactamente el total a cobrar ($${totalToCharge.toLocaleString("es-AR")}: interés $${interest.toLocaleString("es-AR")} + mora $${mora.toLocaleString("es-AR")}).`,
    };

  let newPaymentId;
  await withTransaction(async (client) => {
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession)
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para registrar la renovación.",
        code: "NO_ACTIVE_SESSION",
      };

    const lockedInst = await queries.lockAndGetInstallment(
      client,
      loan.installment_id,
    );
    if (!lockedInst) throw { status: 404, message: "Cuota no encontrada." };
    if (lockedInst.status === "PAID")
      throw {
        status: 409,
        message: "La cuota ya fue pagada; no se puede renovar.",
      };

    const created = await queries.createApproved(client, {
      installmentId: loan.installment_id,
      adminId,
      amountReceived: amounts.amountReceived,
      amountCash: amounts.amountCash,
      amountTransfer: amounts.amountTransfer,
      paymentMethod: amounts.paymentMethod,
      transferReference: data.transfer_reference,
      notes: "Pago por renovación",
      cashSessionId: activeSession.id,
      generationType: "RENEWAL",
    });
    newPaymentId = created.id;

    // Efectos de la renovación (los mismos que aplicará la pre-carga al aprobarse):
    // correr el vencimiento un período, resetear mora/amount_due y anular la
    // próxima visita. El pago NO se aplica a la cuota: el capital sigue debiéndose.
    await _applyRenewalEffects(
      client,
      loan.installment_id,
      loan.payment_frequency,
      graceDays,
      adminId,
    );

    await _registerSplitCashMovements(client, {
      paymentId: newPaymentId,
      amountCash: amounts.amountCash,
      amountTransfer: amounts.amountTransfer,
      movementType: "PAYMENT",
      registerDate: jornadaDate,
      userId: adminId,
    });
  });

  return queries.findById(newPaymentId);
};

/**
 * Revierte totalmente un cobro aprobado y todos sus sub-pagos derivados.
 * Genera un payment compensatorio (is_reversal=TRUE) por cada cuota afectada.
 * No elimina registros — patrón de transacción compensatoria.
 *
 * Reglas:
 *  · Solo pagos APPROVED no revertidos previamente.
 *  · Solo reversiones del día (caja abierta).
 *  · Un cobro solo puede revertirse una vez (unique index en reversed_by_payment_id).
 *
 * @param {string} id     - ID del payment a revertir.
 * @param {string} reason - Motivo obligatorio de la reversión.
 * @param {string} adminId
 */
const reverse = async (id, reason, adminId) => {
  // Días de gracia para el recálculo de status tras restaurar amount_paid
  const graceDays = parseInt((await getValue("penalty_grace_days")) || "3");

  // V4.3: la reversión se imputa a la CAJA ACTIVA de la jornada (no a la del
  // admin que revierte, ni al cash_session_id del payment original que
  // probablemente esté CLOSED). Si no hay caja activa → 409.

  await withTransaction(async (client) => {
    const activeSession =
      await cashSessionsQueries.lockActiveSessionForCurrentJornada(client);
    if (!activeSession)
      throw {
        status: 409,
        message:
          "No hay caja operativa abierta. Abrí una caja para revertir cobros.",
        code: "NO_ACTIVE_SESSION",
      };

    const payment = await queries.lockAndGetPayment(client, id);
    if (!payment) throw { status: 404, message: "Cobro no encontrado." };
    if (payment.status !== "APPROVED")
      throw {
        status: 409,
        message: "Solo se pueden revertir cobros aprobados.",
      };
    if (payment.is_reversal)
      throw {
        status: 409,
        message: "No se puede revertir un cobro que ya es una reversión.",
      };

    // Los sub-pagos generados por distribución (parent_payment_id != null) no se revierten
    // de forma independiente — solo se revierten como parte del cobro padre (total reversal).
    if (payment.parent_payment_id)
      throw {
        status: 409,
        message:
          "Este cobro es un sub-pago por distribución. Para revertirlo, revierta el cobro principal.",
      };

    // Validación 2: verificar con subquery si ya existe un payment que referencia este como original.
    // payment.reversed_by_payment_id es el campo en el payment de REVERSIÓN → no sirve aquí.
    // lockAndGetPayment ya incluye reversal_payment_id via subquery.
    if (payment.reversal_payment_id)
      throw {
        status: 409,
        message: "Este cobro ya fue revertido anteriormente.",
      };

    // Validación 3: la caja de la jornada del cobro no debe estar cerrada.
    // Si el movimiento pertenece a una fecha con cierre, no se puede revertir.
    const movement = await cashMovementsQueries.findPaymentMovement(client, id);
    if (!movement)
      throw {
        status: 409,
        message: "No se encontró movimiento de caja para este cobro.",
      };

    await _validateCajaOpen(movement.register_date);

    // Sub-pagos generados por distribución (cuotas adelantadas) del cobro padre.
    const children = await queries.findChildPayments(client, id);

    // ── Cabecera: ÚNICO pago que impacta caja ──────────────────────────────
    // El dinero entró una sola vez como amount_received del cobro cabecera, así
    // que la reversión saca exactamente ese total (dividido por medio). La
    // reversión se imputa a la caja ACTIVA de la jornada (V4.3).
    await queries.lockAndGetInstallment(client, payment.installment_id);

    const headerReversal = await queries.createReversal(client, {
      installmentId: payment.installment_id,
      adminId,
      amountReceived: payment.amount_received,
      amountCash: payment.amount_cash,
      amountTransfer: payment.amount_transfer,
      paymentMethod: payment.payment_method,
      transferReference: payment.transfer_reference,
      reason,
      cashSessionId: activeSession.id,
      originalPaymentId: payment.id,
    });

    await queries.restoreInstallmentFromReversal(
      client,
      payment.installment_id,
      payment.amount_received,
      graceDays,
    );

    await _registerSplitCashMovements(client, {
      paymentId: headerReversal.id,
      amountCash: payment.amount_cash,
      amountTransfer: payment.amount_transfer,
      movementType: "REVERSAL",
      registerDate: movement.register_date,
      userId: adminId,
    });

    // ── Hijos (cuotas adelantadas): restauran cuota, NO impactan caja ──────
    // Nunca generaron ingreso en caja (su dinero ya está contado dentro del
    // amount_received de la cabecera). Se crea el registro de reversión para
    // auditoría con cash_session_id = NULL, espejo de su pago original. Esto
    // corrige el descuadre histórico (#1) donde la reversión sacaba de caja más
    // de lo que había entrado.
    for (const child of children) {
      await queries.lockAndGetInstallment(client, child.installment_id);

      await queries.createReversal(client, {
        installmentId: child.installment_id,
        adminId,
        amountReceived: child.amount_received,
        amountCash: child.amount_cash,
        amountTransfer: child.amount_transfer,
        paymentMethod: child.payment_method,
        transferReference: child.transfer_reference,
        reason,
        cashSessionId: null, // espejo: el pago adelantado original no tenía caja.
        originalPaymentId: child.id,
      });

      await queries.restoreInstallmentFromReversal(
        client,
        child.installment_id,
        child.amount_received,
        graceDays,
      );
    }

    // Si el crédito estaba SETTLED, reabrirlo
    const credit = await queries.lockAndGetCredit(client, payment.credit_id);
    if (credit && credit.status === "SETTLED") {
      await client.query(
        `UPDATE credits SET status = 'ACTIVE', settled_at = NULL, settlement_type = NULL, updated_at = NOW() WHERE id = $1`,
        [payment.credit_id],
      );
    }

    // Hook: la cuota deja de estar pagada; en la planilla del día vuelve a
    // VISITED para reflejar que el cobrador estuvo pero el cobro fue revertido.
    // Solo aplica a la planilla del cobrador original (payment.collector_id).
    await collectionsQueries.updateManagementStatusForActiveTodaySheet(
      payment.collector_id,
      payment.installment_id,
      "VISITED",
      client,
    );
  });

  return queries.findById(id);
};

/**
 * Genera los pagos APROBADOS de las cuotas adelantadas de una venta AL APROBAR,
 * dentro de la transacción que recibe. Es la pieza reutilizable de generación de
 * pagos por adelanto: recibe las cuotas YA resueltas por el proceso llamador
 * (no re-consulta ni lockea la base, porque la misma tx ya las posee) y deja cada
 * cuota en el mismo estado que un cobro normal. Mantiene `payments` desacoplado de
 * la lógica de `credits`: solo conoce cuotas (id + monto) y datos de pago.
 *
 * Valida, dentro de la misma tx, que la suma de los pagos generados coincida
 * EXACTAMENTE con el monto total del adelanto; ante cualquier diferencia lanza
 * para abortar toda la operación (rollback en el llamador).
 *
 * @param {object} client - Cliente de transacción (la tx la maneja el llamador).
 * @param {object} params
 * @param {Array<{id: string, amountDue: number}>} params.installments - Cuotas a prepagar, resueltas.
 * @param {number} params.amountCash - Total en efectivo del adelanto.
 * @param {number} params.amountTransfer - Total en transferencia del adelanto.
 * @param {string|null} [params.transferReference] - Referencia de transferencia.
 * @param {string} params.adminId - Admin que aprueba.
 * @param {string|null} [params.cashSessionId] - Caja activa a la que se imputa.
 * @param {string} params.batchId - Identificador de la operación (agrupa los pagos).
 * @returns {Promise<{ total: number, count: number, batchId: string }>}
 */
const generatePrepaidInstallmentPayments = async (
  client,
  {
    installments,
    amountCash,
    amountTransfer,
    transferReference = null,
    adminId,
    cashSessionId = null,
    batchId,
  },
) => {
  if (!Array.isArray(installments) || installments.length === 0) {
    throw { status: 400, message: "No hay cuotas adelantadas para registrar." };
  }

  const blockCash = _round2(amountCash || 0);
  const blockTransfer = _round2(amountTransfer || 0);
  const blockTotal = _round2(blockCash + blockTransfer);
  const expectedTotal = _round2(
    installments.reduce((sum, i) => sum + Number(i.amountDue), 0),
  );

  // El split de pago del adelanto debe coincidir con el total de las cuotas.
  if (blockTotal !== expectedTotal) {
    throw {
      status: 409,
      message:
        "El monto del adelanto no coincide con el total de las cuotas adelantadas.",
    };
  }

  const cashRatio = blockTotal > 0 ? blockCash / blockTotal : 0;

  let assignedCash = 0;
  let assignedReceived = 0;

  for (let idx = 0; idx < installments.length; idx++) {
    const inst = installments[idx];
    const amountReceived = _round2(Number(inst.amountDue));
    const isLast = idx === installments.length - 1;

    // Prorrateo del medio por cuota; el resto de redondeo se asigna a la última
    // para que la suma de efectivo/transferencia cuadre EXACTO con el bloque.
    const instCash = isLast
      ? _round2(blockCash - assignedCash)
      : _round2(amountReceived * cashRatio);
    const instTransfer = _round2(amountReceived - instCash);

    assignedCash = _round2(assignedCash + instCash);
    assignedReceived = _round2(assignedReceived + amountReceived);

    const paymentMethod =
      instCash > 0 && instTransfer > 0
        ? "MIXED"
        : instTransfer > 0
          ? "TRANSFER"
          : "CASH";

    await queries.createApprovalPrepaymentPayment(client, {
      installmentId: inst.id,
      amountReceived,
      amountCash: instCash,
      amountTransfer: instTransfer,
      paymentMethod,
      transferReference,
      adminId,
      cashSessionId,
      batchId,
    });
  }

  // Validación transaccional final: la suma de los pagos generados === total.
  if (assignedReceived !== expectedTotal) {
    throw {
      status: 409,
      message:
        "La suma de los pagos de cuotas adelantadas no coincide con el monto del adelanto.",
    };
  }

  return { total: expectedTotal, count: installments.length, batchId };
};

module.exports = {
  getAll,
  getById,
  create,
  approve,
  reject,
  getByCredit,
  adminDirect,
  renew,
  reverse,
  generatePrepaidInstallmentPayments,
  // Núcleo exportado para reutilización en nuevos flujos
  _validateCajaOpen,
  _applyPaymentToInstallments,
  _checkAndSettleCredit,
  _registerCashMovement,
  _registerSplitCashMovements,
  _normalizePaymentAmounts,
};
