const service  = require('./overdueNotice.service');
const response = require('../../utils/response');

// POST /api/installments/:id/notify-overdue
const notifyOverdue = async (req, res) => {
  try {
    const result = await service.notifyOverdue(req.params.id, req.user);
    if (result.already_notified)
      return response.success(res, result, 'El cliente ya fue avisado hoy por esta cuota.');
    return response.created(res, result, 'Aviso de mora enviado al cliente.');
  } catch (err) {
    if (err.status && err.status !== 500) {
      const body = { ok: false, message: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
    return response.serverError(res, err);
  }
};

module.exports = { notifyOverdue };
