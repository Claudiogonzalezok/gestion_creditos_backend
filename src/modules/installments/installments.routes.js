const router        = require('express').Router();
const controller    = require('./installments.controller');
const { query }     = require('express-validator');
const v             = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('status').optional()
      .isIn(['PENDING','OVERDUE','PAID','PARTIAL'])
      .withMessage('status debe ser PENDING, OVERDUE, PAID o PARTIAL.'),
    query('collector_id').optional()
      .isUUID().withMessage('collector_id debe ser un UUID válido.'),
    query('credit_id').optional()
      .isUUID().withMessage('credit_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), v.penalties.id, validate, controller.getById);

router.patch('/:id/apply-penalty',
  authorize('ADMIN'), v.penalties.apply,    validate, controller.applyPenalty
);
router.patch('/:id/waive-penalty',
  authorize('ADMIN'), v.penalties.id,       validate, controller.waivePenalty
);
router.patch('/:id/early-pay',
  authorize('ADMIN'), v.penalties.earlyPay, validate, controller.earlyPay
);

module.exports = router;
