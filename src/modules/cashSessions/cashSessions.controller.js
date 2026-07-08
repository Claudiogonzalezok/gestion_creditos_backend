const service = require("./cashSessions.service");
const response = require("../../utils/response");

const handleError = (res, err) => {
  if (err.status === 404) return response.notFound(res, err.message);
  if (err.status === 409) return response.conflict(res, err.message);
  if (err.status === 422)
    return res.status(422).json({ ok: false, message: err.message });
  return response.serverError(res, err);
};

const open = async (req, res) => {
  try {
    const session = await service.open(req.body, req.user);
    return res
      .status(201)
      .json({
        ok: true,
        message: "Caja abierta correctamente.",
        data: session,
      });
  } catch (err) {
    return handleError(res, err);
  }
};

const getActive = async (req, res) => {
  try {
    const ownerUserId =
      req.query.owner === "me" || !req.query.owner
        ? req.user.id
        : req.query.owner;
    return response.success(res, await service.getActive(ownerUserId));
  } catch (err) {
    return handleError(res, err);
  }
};

const getById = async (req, res) => {
  try {
    return response.success(res, await service.getById(req.params.id));
  } catch (err) {
    return handleError(res, err);
  }
};

const getAll = async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      ownerUserId: req.query.owner_user_id,
      businessDayId: req.query.business_day_id,
      businessDate: req.query.business_date,
      branchId: req.query.branch_id,
    };
    return response.success(res, await service.getAll(filters));
  } catch (err) {
    return handleError(res, err);
  }
};

const snapshot = async (req, res) => {
  try {
    return response.success(res, await service.snapshot(req.params.id));
  } catch (err) {
    return handleError(res, err);
  }
};

const close = async (req, res) => {
  try {
    const data = await service.close(req.params.id, req.body, req.user);
    return res.status(200).json({ ok: true, message: "Caja cerrada.", data });
  } catch (err) {
    return handleError(res, err);
  }
};

const markPending = async (req, res) => {
  try {
    const data = await service.markPending(req.params.id, req.body, req.user);
    return res
      .status(200)
      .json({
        ok: true,
        message: "Caja marcada como pendiente de conciliación.",
        data,
      });
  } catch (err) {
    return handleError(res, err);
  }
};

const reconcile = async (req, res) => {
  try {
    const data = await service.reconcile(req.params.id, req.body, req.user);
    return res
      .status(200)
      .json({ ok: true, message: "Caja conciliada.", data });
  } catch (err) {
    return handleError(res, err);
  }
};

const addDrop = async (req, res) => {
  try {
    const data = await service.addDrop(req.params.id, req.body, req.user);
    return res
      .status(201)
      .json({ ok: true, message: "Drop registrado.", data });
  } catch (err) {
    return handleError(res, err);
  }
};

const addManualIncome = async (req, res) => {
  try {
    const data = await service.addManualIncome(
      req.params.id,
      req.body,
      req.user,
    );
    return res
      .status(201)
      .json({ ok: true, message: "Ingreso manual registrado.", data });
  } catch (err) {
    return handleError(res, err);
  }
};

const reverseDrop = async (req, res) => {
  try {
    const data = await service.reverseDrop(
      req.params.id,
      req.params.dropId,
      req.body,
      req.user,
    );
    return res.status(200).json({ ok: true, message: "Drop revertido.", data });
  } catch (err) {
    return handleError(res, err);
  }
};

module.exports = {
  open,
  getActive,
  getById,
  getAll,
  snapshot,
  close,
  markPending,
  reconcile,
  addDrop,
  reverseDrop,
  addManualIncome,
};
