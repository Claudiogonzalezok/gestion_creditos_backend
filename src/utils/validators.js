const { body, param, query } = require('express-validator');

// ============================================================
//  REGLAS REUTILIZABLES — bloques atómicos que se combinan
// ============================================================

// ── Strings generales ─────────────────────────────────────────
const isString = (field, label, { min = 1, max = 150, required = true } = {}) => {
  let rule = body(field).trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isString().withMessage(`${label} debe ser texto.`)
    .isLength({ min, max })
    .withMessage(`${label} debe tener entre ${min} y ${max} caracteres.`);
};

// ── DNI ───────────────────────────────────────────────────────
const isDni = (field = 'dni', required = true) => {
  let rule = body(field).trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isString().withMessage('El DNI debe ser texto.')
    .isLength({ min: 7, max: 9 }).withMessage('El DNI debe tener entre 7 y 9 caracteres.')
    .matches(/^\d+$/).withMessage('El DNI solo puede contener números.');
};

// ── Email ─────────────────────────────────────────────────────
const isEmail = (required = false) => {
  let rule = body('email').trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isEmail().withMessage('El email debe tener un formato válido.')
    .isLength({ max: 150 }).withMessage('El email no puede superar los 150 caracteres.')
    .normalizeEmail();
};

// ── Teléfono ──────────────────────────────────────────────────
const isPhone = (required = false) => {
  let rule = body('phone').trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isString().withMessage('El teléfono debe ser texto.')
    .isLength({ min: 6, max: 30 }).withMessage('El teléfono debe tener entre 6 y 30 caracteres.')
    .matches(/^\d+$/).withMessage('El telefono solo puede contener números.');
};

// ── UUID ──────────────────────────────────────────────────────
const isUUID = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isUUID().withMessage(`${label} debe ser un identificador UUID válido.`);
};

const isUUIDParam = (field, label) =>
  param(field)
    .isUUID().withMessage(`${label} debe ser un identificador UUID válido.`);

// ── Enum ──────────────────────────────────────────────────────
const isEnum = (field, label, values, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isIn(values)
    .withMessage(`${label} debe ser uno de los siguientes valores: ${values.join(', ')}.`);
};

// ── Numérico positivo ─────────────────────────────────────────
const isPositiveNumber = (field, label, { min = 0.01, max = 99999999, required = true } = {}) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isFloat({ min, max })
    .withMessage(`${label} debe ser un número entre ${min} y ${max}.`);
};

// ── Entero positivo ───────────────────────────────────────────
const isPositiveInt = (field, label, { min = 1, max = 9999, required = true } = {}) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isInt({ min, max })
    .withMessage(`${label} debe ser un número entero entre ${min} y ${max}.`);
};

// ── Contraseña ────────────────────────────────────────────────
const isPassword = (field = 'password', label = 'La contraseña') => {
  return body(field)
    .notEmpty().withMessage(`${label} es obligatoria.`)
    .isLength({ min: 8, max: 100 }).withMessage(`${label} debe tener entre 8 y 100 caracteres.`)
    .matches(/\d/).withMessage(`${label} debe contener al menos un número.`);
};

// ── Fecha ─────────────────────────────────────────────────────
const isDate = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isISO8601().withMessage(`${label} debe ser una fecha válida en formato YYYY-MM-DD.`)
    .toDate();
};

// ── Booleano ──────────────────────────────────────────────────
const isBool = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isBoolean().withMessage(`${label} debe ser verdadero o falso.`)
    .toBoolean();
};

// ── Query param: paginación ───────────────────────────────────
const paginationRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('La página debe ser un número entero mayor a 0.').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('El límite debe ser entre 1 y 100.').toInt(),
];

// ============================================================
//  VALIDADORES COMPLETOS POR MÓDULO
// ============================================================

// ── USERS ─────────────────────────────────────────────────────
const users = {
  create: [
    isString('full_name', 'El nombre completo', { min: 3, max: 150 }),
    isDni('dni'),
    isEmail(false),
    body('address').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 255 }).withMessage('La dirección no puede superar los 255 caracteres.'),
    isEnum('role', 'El rol', ['ADMIN','SELLER','COLLECTOR']),
  ],
  update: [
    isUUIDParam('id', 'El ID de usuario'),
    isString('full_name', 'El nombre completo', { min: 3, max: 150, required: false }),
    isDni('dni', false),
    isEmail(false),
    body('address').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 255 }).withMessage('La dirección no puede superar los 255 caracteres.'),
    isEnum('role', 'El rol', ['ADMIN','SELLER','COLLECTOR'], false),
  ],
  changePassword: [
    body('current_password')
      .notEmpty().withMessage('La contraseña actual es obligatoria.'),
    isPassword('new_password', 'La nueva contraseña'),
    body('new_password').custom((val, { req }) => {
      if (val === req.body.current_password)
        throw new Error('La nueva contraseña no puede ser igual a la actual.');
      return true;
    }),
  ],
  id: [ isUUIDParam('id', 'El ID de usuario') ],
};

// ── CUSTOMERS ─────────────────────────────────────────────────
const customers = {
  create: [
    isString('full_name', 'El nombre completo', { min: 3, max: 150 }),
    isDni('dni'),
    isPhone(false),
    isEmail(false),
    body('address').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 255 }).withMessage('La dirección no puede superar los 255 caracteres.'),
    isUUID('assigned_collector_id', 'El cobrador asignado', false),
  ],
  update: [
    isUUIDParam('id', 'El ID de cliente'),
    isString('full_name', 'El nombre completo', { min: 3, max: 150, required: false }),
    isPhone(false),
    isEmail(false),
    body('address').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 255 }).withMessage('La dirección no puede superar los 255 caracteres.'),
    isUUID('assigned_collector_id', 'El cobrador asignado', false),
  ],
  id: [ isUUIDParam('id', 'El ID de cliente') ],
};

// ── PRODUCTS ──────────────────────────────────────────────────
const products = {
  create: [
    isString('name', 'El nombre del producto', { min: 2, max: 150 }),
    body('description').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 1000 }).withMessage('La descripción no puede superar los 1000 caracteres.'),
    isPositiveNumber('current_price', 'El precio', { min: 0.01, max: 99999999 }),
    body('available_stock')
      .isInt({ min: 0, max: 999999 })
      .withMessage('El stock debe ser un número entero entre 0 y 999.999.'),
  ],
  update: [
    isUUIDParam('id', 'El ID de producto'),
    isString('name', 'El nombre del producto', { min: 2, max: 150, required: false }),
    body('description').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 1000 }).withMessage('La descripción no puede superar los 1000 caracteres.'),
    isPositiveNumber('current_price', 'El precio', { min: 0.01, max: 99999999, required: false }),
  ],
  adjustStock: [
    isUUIDParam('id', 'El ID de producto'),
    isEnum('movement', 'El tipo de movimiento', ['IN','OUT']),
    body('quantity')
      .isInt({ min: 1, max: 99999 })
      .withMessage('La cantidad debe ser un número entero entre 1 y 99.999.'),
    body('reason').trim()
      .notEmpty().withMessage('El motivo del ajuste es obligatorio.')
      .isLength({ max: 255 }).withMessage('El motivo no puede superar los 255 caracteres.'),
  ],
  id: [ isUUIDParam('id', 'El ID de producto') ],
};

// ── CREDITS ───────────────────────────────────────────────────
const credits = {
  create: [
    isUUID('customer_id', 'El cliente'),
    isEnum('type', 'El tipo de crédito', ['SALE','LOAN']),
    isPositiveNumber('total_amount', 'El monto total', { min: 1, max: 99999999 }),
    body('installments_count')
      .isInt({ min: 1, max: 120 })
      .withMessage('La cantidad de cuotas debe ser un número entre 1 y 120.'),
    isEnum('payment_frequency', 'La frecuencia de pago', ['WEEKLY','BIWEEKLY','MONTHLY']),
    body('products').optional().isArray({ min: 1 })
      .withMessage('Los productos deben ser un arreglo con al menos un ítem.'),
    body('products.*.product_id').optional()
      .isUUID().withMessage('Cada product_id debe ser un UUID válido.'),
    body('products.*.quantity').optional()
      .isInt({ min: 1, max: 9999 }).withMessage('La cantidad de cada producto debe ser entre 1 y 9999.'),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las notas no pueden superar los 500 caracteres.'),
  ],
  simulate: [
    isEnum('type', 'El tipo de crédito', ['SALE','LOAN']),
    isPositiveNumber('total_amount', 'El monto total', { min: 1, max: 99999999 }),
    body('installments_count')
      .isInt({ min: 1, max: 120 })
      .withMessage('La cantidad de cuotas debe ser un número entre 1 y 120.'),
    isEnum('payment_frequency', 'La frecuencia de pago', ['WEEKLY','BIWEEKLY','MONTHLY']),
  ],
  approve: [
    isUUIDParam('id', 'El ID de crédito'),
    body('installments_count').optional()
      .isInt({ min: 1, max: 120 })
      .withMessage('La cantidad de cuotas debe ser entre 1 y 120.'),
  ],
  reject: [
    isUUIDParam('id', 'El ID de crédito'),
    body('rejection_reason').trim()
      .notEmpty().withMessage('El motivo de rechazo es obligatorio.')
      .isLength({ min: 5, max: 500 }).withMessage('El motivo debe tener entre 5 y 500 caracteres.'),
  ],
  earlySettlement: [
    isUUIDParam('id', 'El ID de crédito'),
    isEnum('payment_method', 'El método de pago', ['CASH','TRANSFER']),
    body('transfer_reference').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 100 }).withMessage('La referencia no puede superar los 100 caracteres.'),
  ],
  id: [ isUUIDParam('id', 'El ID de crédito') ],
};

// ── PAYMENTS (pre-cargas de cobro) ────────────────────────────
const payments = {
  create: [
    isUUID('installment_id', 'La cuota'),
    isPositiveNumber('amount_received', 'El monto recibido', { min: 0.01, max: 99999999 }),
    isEnum('payment_method', 'El método de pago', ['CASH','TRANSFER']),
    body('transfer_reference').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 100 }).withMessage('La referencia de transferencia no puede superar los 100 caracteres.'),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las observaciones no pueden superar los 500 caracteres.'),
  ],
  reject: [
    isUUIDParam('id', 'El ID de cobro'),
    body('rejection_reason').trim()
      .notEmpty().withMessage('El motivo de rechazo es obligatorio.')
      .isLength({ min: 5, max: 500 }).withMessage('El motivo debe tener entre 5 y 500 caracteres.'),
  ],
  id: [ isUUIDParam('id', 'El ID de cobro') ],
};

// ── INTEREST RATES ────────────────────────────────────────────
const interestRates = {
  create: [
    isEnum('credit_type', 'El tipo de crédito', ['SALE','LOAN']),
    body('installments_count')
      .isInt({ min: 1, max: 120 })
      .withMessage('La cantidad de cuotas debe ser entre 1 y 120.'),
    isEnum('payment_frequency', 'La frecuencia de pago', ['WEEKLY','BIWEEKLY','MONTHLY']),
    body('rate')
      .isFloat({ min: 0.0001, max: 1 })
      .withMessage('La tasa debe ser un decimal entre 0.0001 y 1 (ej: 0.08 = 8%).'),
  ],
  update: [
    isUUIDParam('id', 'El ID de tasa'),
    body('rate')
      .isFloat({ min: 0.0001, max: 1 })
      .withMessage('La tasa debe ser un decimal entre 0.0001 y 1 (ej: 0.08 = 8%).'),
    isBool('active', 'El estado', false),
  ],
  id: [ isUUIDParam('id', 'El ID de tasa') ],
};

// ── CASH REGISTER ─────────────────────────────────────────────
const cashRegister = {
  close: [
    body('declared_cash')
      .isFloat({ min: 0 })
      .withMessage('El efectivo declarado debe ser un número mayor o igual a 0.'),
    body('observations').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las observaciones no pueden superar los 500 caracteres.'),
  ],
};

// ── PENALTIES (mora) ──────────────────────────────────────────
const penalties = {
  apply: [
    isUUIDParam('id', 'El ID de cuota'),
    body('penalty_amount')
      .isFloat({ min: 0.01 })
      .withMessage('El monto de mora debe ser mayor a 0.'),
    body('reason').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 255 }).withMessage('El motivo no puede superar los 255 caracteres.'),
  ],
  id: [ isUUIDParam('id', 'El ID de cuota') ],
};

// ── COLLECTIONS (planillas de cobro) ─────────────────────────
const collections = {
  generate: [
    isUUID('collector_id', 'El cobrador'),
    isDate('date', 'La fecha de cobro'),
    isEnum('filter', 'El filtro de cuotas',
      ['TODAY','OVERDUE','TODAY_AND_OVERDUE','ALL_PENDING'], false),
  ],
  id: [ isUUIDParam('id', 'El ID de planilla') ],
};

// ── COMMISSIONS ───────────────────────────────────────────────
const commissions = {
  liquidate: [
    isUUID('user_id', 'El usuario a liquidar'),
    isEnum('payment_method', 'El método de pago', ['CASH','TRANSFER']),
    body('transfer_reference').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 100 }).withMessage('La referencia no puede superar los 100 caracteres.'),
  ],
};

// ── AUTH ──────────────────────────────────────────────────────
const auth = {
  login: [
    body('dni').trim()
      .notEmpty().withMessage('El DNI es obligatorio.')
      .isLength({ min: 7, max: 20 }).withMessage('El DNI debe tener entre 7 y 20 caracteres.'),
    body('password')
      .notEmpty().withMessage('La contraseña es obligatoria.')
      .isLength({ max: 100 }).withMessage('La contraseña no puede superar los 100 caracteres.'),
  ],
};

module.exports = {
  // Bloques atómicos reutilizables
  isString, isDni, isEmail, isPhone, isUUID, isUUIDParam,
  isEnum, isPositiveNumber, isPositiveInt, isPassword, isDate, isBool,
  paginationRules,
  // Validadores completos por módulo
  users,
  customers,
  products,
  credits,
  payments,
  interestRates,
  cashRegister,
  penalties,
  collections,
  commissions,
  auth,
};
