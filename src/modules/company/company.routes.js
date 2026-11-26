const router       = require('express').Router();
const { body }     = require('express-validator');
const controller   = require('./company.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// Lectura y escritura solo ADMIN: incluye tasas y comisión (decisión #88).
router.use(authenticate, authorize('ADMIN'));

/**
 * Texto opcional: null o "" vacían el campo.
 * @param {string} field
 * @param {number} max
 */
const optionalText = (field, max) =>
  body(field)
    .optional({ nullable: true })
    .isString().withMessage(`${field} debe ser texto.`)
    .bail()
    .trim()
    .isLength({ max }).withMessage(`${field} admite hasta ${max} caracteres.`)
    .customSanitizer((v) => (v === '' ? null : v));

const companyRules = [
  body('system_name')
    .optional()
    .isString().withMessage('system_name debe ser texto.')
    .bail()
    .trim()
    .notEmpty().withMessage('El nombre del sistema no puede quedar vacío.')
    .isLength({ max: 150 }).withMessage('system_name admite hasta 150 caracteres.'),
  body('contact_email')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isEmail().withMessage('El email de contacto no es válido.')
    .isLength({ max: 150 }).withMessage('contact_email admite hasta 150 caracteres.'),
  optionalText('phone', 30),
  optionalText('address', 255),
  body('low_stock_threshold')
    .optional()
    .isInt({ min: 0, max: 100000 }).withMessage('low_stock_threshold debe ser un entero entre 0 y 100000.')
    .bail()
    .toInt(),
  body().custom((b) => {
    const fields = ['system_name', 'contact_email', 'phone', 'address', 'low_stock_threshold'];
    if (!b || !fields.some((f) => b[f] !== undefined))
      throw new Error('Debe enviar al menos un campo a actualizar.');
    return true;
  }),
];

const rateField = (field, max, label) =>
  body(field)
    .optional()
    .isFloat({ min: 0, max }).withMessage(`${label} debe ser un número entre 0 y ${max}.`);

const ratesRules = [
  rateField('sale_rate_monthly', 1, 'La tasa VENTA'),
  rateField('loan_rate_monthly', 1, 'La tasa PRÉSTAMO'),
  rateField('mora_rate_daily', 0.5, 'La tasa MORA'),
  rateField('seller_commission_rate', 1, 'La comisión de vendedor'),
  body('grace_period_days')
    .optional()
    .isInt({ min: 0, max: 30 }).withMessage('El período de gracia debe ser un entero entre 0 y 30.'),
];

router.get('/', controller.get);
router.put('/', companyRules, validate, controller.updateCompany);
router.put('/rates', ratesRules, validate, controller.updateRates);

module.exports = router;
