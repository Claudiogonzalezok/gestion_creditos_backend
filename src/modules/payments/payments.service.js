const pool = require("../../config/db");
const queries = require("./payments.queries");
const cashMovementsQueries = require("./cash_movements.queries");
const cashSessionsQueries = require("../cashSessions/cashSessions.queries");
const businessDaysQueries = require("../businessDays/businessDays.queries");
const {
  getActiveJornadaDate,
} = require("../businessDays/businessDays.service");
const collectionsQueries = require("../collections/collections.queries");
const { getValue } = require("../systemConfig/systemConfig.queries");
const { withTransaction } = require("../../utils/transaction");

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

  const amountReceived = parseFloat(data.amount_received);

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
    amount_received: data.amount_received,
    payment_method: data.payment_method,
    transfer_reference: data.transfer_reference,
    notes: data.notes,
    next_visit_date: data.next_visit_date,
    cash_session_id: null, // V4.2: se llena en approve.
  });

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

    // 3. Registrar movimiento contable en caja — se usa la fecha de la jornada activa,
    //    no localDate(), para que los cobros post-medianoche queden en la jornada correcta.
    await _registerCashMovement(client, {
      paymentId: id,
      amount: parseFloat(payment.amount_received),
      paymentMethod: payment.payment_method,
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

  const amountReceived = parseFloat(data.amount_received);
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
      paymentMethod: data.payment_method,
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
      payment_method: data.payment_method,
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

    await _registerCashMovement(client, {
      paymentId: newPaymentId,
      amount: amountReceived,
      paymentMethod: data.payment_method,
      movementType: "PAYMENT",
      registerDate: jornadaDate,
      userId: adminId,
    });

    await _checkAndSettleCredit(client, lockedInst.credit_id);
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

    // Recolectar todos los pagos a revertir: el principal + sus sub-pagos
    const children = await queries.findChildPayments(client, id);
    const toReverse = [payment, ...children];

    for (const p of toReverse) {
      // Lock sobre la cuota afectada
      await queries.lockAndGetInstallment(client, p.installment_id);

      const reversal = await queries.createReversal(client, {
        installmentId: p.installment_id,
        adminId,
        amountReceived: p.amount_received,
        paymentMethod: p.payment_method,
        transferReference: p.transfer_reference,
        reason,
        cashSessionId: activeSession.id,
        originalPaymentId: p.id,
      });

      await queries.restoreInstallmentFromReversal(
        client,
        p.installment_id,
        p.amount_received,
        graceDays,
      );

      await _registerCashMovement(client, {
        paymentId: reversal.id,
        amount: p.amount_received,
        paymentMethod: p.payment_method,
        movementType: "REVERSAL",
        registerDate: movement.register_date,
        userId: adminId,
      });
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

module.exports = {
  getAll,
  getById,
  create,
  approve,
  reject,
  getByCredit,
  adminDirect,
  reverse,
  // Núcleo exportado para reutilización en nuevos flujos
  _validateCajaOpen,
  _applyPaymentToInstallments,
  _checkAndSettleCredit,
  _registerCashMovement,
};
