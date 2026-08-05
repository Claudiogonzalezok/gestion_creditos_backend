const service = require("./credits.service");
const paymentsService = require("../payments/payments.service");
const response = require("../../utils/response");
const irQueries = require("../interestRates/interestRates.queries");
const prQueries = require("../productRates/productRates.queries");

const getAll = async (req, res) => {
  try {
    const { status, type, customer_id } = req.query;
    return response.success(
      res,
      await service.getAll({ status, type, customer_id }, req.user),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id));
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const create = async (req, res) => {
  try {
    const {
      customer_id,
      type,
      payment_condition,
      total_amount,
      installments_count,
      payment_frequency,
      unit_ids,
      notes,
      down_payment,
      down_payment_cash,
      down_payment_transfer,
      down_payment_method,
      down_payment_transfer_reference,
      prepaid_installments,
      prepaid_installments_cash,
      prepaid_installments_transfer,
      prepaid_installments_method,
      prepaid_installments_transfer_reference,
      first_payment_date,
      // Venta de contado: pago del total declarado al crear.
      payment_amount,
      payment_cash,
      payment_transfer,
      payment_method,
      transfer_reference,
    } = req.body;
    const credit = await service.create(
      {
        customer_id,
        type,
        payment_condition,
        total_amount,
        installments_count,
        payment_frequency,
        unit_ids,
        notes,
        down_payment,
        down_payment_cash,
        down_payment_transfer,
        down_payment_method,
        down_payment_transfer_reference,
        prepaid_installments,
        prepaid_installments_cash,
        prepaid_installments_transfer,
        prepaid_installments_method,
        prepaid_installments_transfer_reference,
        first_payment_date,
        payment_amount,
        payment_cash,
        payment_transfer,
        payment_method,
        transfer_reference,
      },
      req.user,
    );
    return response.created(
      res,
      credit,
      "Pre-operación registrada. Pendiente de aprobación.",
    );
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const getSimulateOptions = async (req, res) => {
  try {
    const options = await irQueries.findActiveInstallmentOptions();
    return response.success(res, options);
  } catch (err) {
    return response.serverError(res, err);
  }
};

const simulate = async (req, res) => {
  try {
    const {
      type,
      total_amount,
      installments_count,
      payment_frequency,
      products,
      down_payment,
      first_payment_date,
    } = req.body;
    return response.success(
      res,
      await service.simulate({
        type,
        total_amount,
        installments_count,
        payment_frequency,
        products,
        down_payment,
        first_payment_date,
      }),
      "Simulación calculada.",
    );
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const simulateAll = async (req, res) => {
  try {
    const { type, total_amount, products } = req.body;
    return response.success(
      res,
      await service.simulateAll({ type, total_amount, products }),
      "Simulaciones calculadas.",
    );
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    return response.serverError(res, err);
  }
};

const getSimulateProducts = async (req, res) => {
  try {
    const search = String(req.query.search || "")
      .trim()
      .slice(0, 100);
    const limit = parseInt(req.query.limit) || 10;
    return response.success(
      res,
      await prQueries.findProductsWithActiveRates({ search, limit }),
    );
  } catch (err) {
    return response.serverError(res, err);
  }
};

const approve = async (req, res) => {
  try {
    const credit = await service.approve(
      req.params.id,
      req.user.id,
      req.body?.installments_count,
    );
    return response.success(
      res,
      credit,
      "Crédito aprobado. Cuotas generadas correctamente.",
    );
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message, null, err.code);
    return response.serverError(res, err);
  }
};

const renew = async (req, res) => {
  try {
    const payment = await paymentsService.renew(
      req.params.id,
      req.body,
      req.user.id,
    );
    return response.created(
      res,
      payment,
      "Renovación registrada. Vencimiento extendido un período.",
    );
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409)
      return response.conflict(res, err.message, null, err.code);
    if (err.status === 422)
      return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

const changeSeller = async (req, res) => {
  try {
    const credit = await service.changeSeller(
      req.params.id,
      req.body.seller_id,
      req.user.id,
    );
    return response.success(res, credit, "Vendedor actualizado.");
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

const reject = async (req, res) => {
  try {
    await service.reject(req.params.id, req.body.rejection_reason, req.user.id);
    return response.success(res, null, "Crédito rechazado.");
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const earlySettlement = async (req, res) => {
  try {
    const result = await service.earlySettlement(
      req.params.id,
      req.body,
      req.user.id,
    );
    return response.success(
      res,
      result,
      "Cancelación anticipada procesada correctamente.",
    );
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

const refinance = async (req, res) => {
  try {
    const {
      installments_count,
      payment_frequency,
      reason,
      extra_charges,
      notes,
    } = req.body;
    const result = await service.refinance(
      req.params.id,
      { installments_count, payment_frequency, reason, extra_charges, notes },
      req.user.id,
    );
    return response.created(res, result, result.message);
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

// Cambio de plan — Etapa 1: simulación (solo lectura, no ejecuta)
const planChangeSimulate = async (req, res) => {
  try {
    const result = await service.simulatePlanChange(req.params.id);
    return response.success(res, result);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422)
      return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

// Cambio de plan — Etapa 2: ejecución (admin-only, sin doble aprobación)
const planChangeExecute = async (req, res) => {
  try {
    const result = await service.changePlan(
      req.params.id,
      { reason: req.body.reason },
      req.user.id,
    );
    return response.success(res, result, result.message);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    if (err.status === 422)
      return response.unprocessableEntity(res, err.message);
    return response.serverError(res, err);
  }
};

// Castigo de crédito (write off) — admin-only
const writeOff = async (req, res) => {
  try {
    const { reason, observations } = req.body;
    const result = await service.writeOffCredit(
      req.params.id,
      { reason, observations },
      req.user.id,
    );
    return response.success(res, result, result.message);
  } catch (err) {
    if (err.status === 404) return response.notFound(res, err.message);
    if (err.status === 409) return response.conflict(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = {
  getAll,
  getById,
  create,
  getSimulateOptions,
  getSimulateProducts,
  simulate,
  simulateAll,
  approve,
  renew,
  changeSeller,
  reject,
  earlySettlement,
  refinance,
  planChangeSimulate,
  planChangeExecute,
  writeOff,
};
