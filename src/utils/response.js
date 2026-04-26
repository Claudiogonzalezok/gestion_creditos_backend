// Respuesta exitosa estándar
const success = (res, data = null, message = 'OK', statusCode = 200) => {
  return res.status(statusCode).json({
    ok:      true,
    message,
    data,
  });
};

// Respuesta de creación
const created = (res, data = null, message = 'Recurso creado correctamente') => {
  return success(res, data, message, 201);
};

// Respuesta de error del cliente
const badRequest = (res, message = 'Solicitud inválida', errors = null) => {
  return res.status(400).json({
    ok:      false,
    message,
    errors,
  });
};

// Recurso no encontrado
const notFound = (res, message = 'Recurso no encontrado') => {
  return res.status(404).json({
    ok:      false,
    message,
  });
};

// Sin autorización (no autenticado)
const unauthorized = (res, message = 'No autenticado. Token inválido o expirado') => {
  return res.status(401).json({
    ok:      false,
    message,
  });
};

// Sin permisos (autenticado pero sin rol suficiente)
const forbidden = (res, message = 'No tenés permisos para realizar esta acción') => {
  return res.status(403).json({
    ok:      false,
    message,
  });
};

// Conflicto (ej: DNI duplicado, pre-cargas pendientes)
const conflict = (res, message = 'El recurso ya existe', data = null) => {
  const body = { ok: false, message };
  if (data !== null) body.data = data;
  return res.status(409).json(body);
};

// Entidad no procesable (ej: monto supera el saldo disponible)
const unprocessableEntity = (res, message = 'No se puede procesar la solicitud') => {
  return res.status(422).json({
    ok:      false,
    message,
  });
};

// Error interno del servidor
const serverError = (res, err) => {
  console.error('🔴  Error interno:', err);
  return res.status(500).json({
    ok:      false,
    message: 'Error interno del servidor. Intentá nuevamente más tarde.',
  });
};

module.exports = {
  success,
  created,
  badRequest,
  notFound,
  unauthorized,
  forbidden,
  conflict,
  unprocessableEntity,
  serverError,
};
