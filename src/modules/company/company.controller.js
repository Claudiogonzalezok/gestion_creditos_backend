const service  = require('./company.service');
const response = require('../../utils/response');

// GET /api/company
const get = async (req, res) => {
  try {
    return response.success(res, await service.get());
  } catch (err) {
    return response.serverError(res, err);
  }
};

// PUT /api/company
const updateCompany = async (req, res) => {
  try {
    const { system_name, contact_email, phone, address } = req.body;
    const data = await service.updateCompany({ system_name, contact_email, phone, address }, req.user.id);
    return response.success(res, data, 'Datos de la empresa actualizados correctamente.');
  } catch (err) {
    return response.serverError(res, err);
  }
};

// PUT /api/company/rates
const updateRates = async (req, res) => {
  try {
    const data = await service.updateRates(req.body, req.user.id);
    return response.success(res, data, 'Tasas de la empresa actualizadas correctamente.');
  } catch (err) {
    if (err.status === 400) return response.badRequest(res, err.message);
    return response.serverError(res, err);
  }
};

module.exports = { get, updateCompany, updateRates };
