const { validationResult } = require('express-validator');
const response = require('../utils/response');

// Ejecutar después de las reglas de validación de express-validator
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return response.badRequest(
      res,
      'Datos inválidos. Revisá los campos marcados.',
      errors.array().map(e => ({ field: e.path, message: e.msg }))
    );
  }
  next();
};

module.exports = { validate };
