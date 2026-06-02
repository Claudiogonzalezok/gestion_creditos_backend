const router        = require('express').Router();
const controller    = require('./cashAccounts.controller');
const { param, query, body } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// Toda la API de Caja General es ADMIN-only: es tesorería, no caja operativa.
router.use(authenticate);
router.use(authorize('ADMIN'));

const idParam = [param('id').isUUID().withMessage('El id debe ser un UUID válido.')];

const PUBLIC_TYPES = ['SUPPLIER_PAYMENT', 'SALARY_PAYMENT', 'EXPENSE', 'ADJUSTMENT'];
const ALL_TYPES    = ['DROP_IN', ...PUBLIC_TYPES];

router.get('/', controller.getAll);

router.get('/:id', idParam, validate, controller.getById);

router.get('/:id/balance', idParam, validate, controller.getBalance);

router.get('/:id/audit-balance', idParam, validate, controller.getAuditBalance);

router.get('/:id/movements',
  [
    ...idParam,
    query('movement_type').optional().isIn(ALL_TYPES)
      .withMessage(`movement_type debe ser uno de: ${ALL_TYPES.join(', ')}.`),
    query('direction').optional().isIn(['IN','OUT']),
    query('from').optional().isISO8601().withMessage('from debe ser ISO8601.'),
    query('to').optional().isISO8601().withMessage('to debe ser ISO8601.'),
    query('page').optional().isInt({ min: 1 }),
    query('page_size').optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  controller.listMovements,
);

router.post('/:id/movements',
  [
    ...idParam,
    body('movement_type').isIn(PUBLIC_TYPES)
      .withMessage(`movement_type debe ser uno de: ${PUBLIC_TYPES.join(', ')}.`),
    body('direction').optional({ nullable: true }).isIn(['IN','OUT'])
      .withMessage('direction debe ser IN u OUT (solo aplica a ADJUSTMENT).'),
    body('amount').isFloat({ gt: 0 }).withMessage('amount debe ser > 0.'),
    body('description').optional({ nullable: true }).isString().isLength({ max: 1000 }),
    body('beneficiary_name').optional({ nullable: true }).isString().isLength({ max: 200 }),
  ],
  validate,
  controller.registerMovement,
);

module.exports = router;
