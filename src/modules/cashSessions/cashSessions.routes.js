const router        = require('express').Router();
const controller    = require('./cashSessions.controller');
const { param, query, body } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

const idParam = [param('id').isUUID().withMessage('El id debe ser un UUID válido.')];
const declaredArray = body('declared').isArray({ min: 1 }).withMessage('declared debe ser un array con al menos un método.');
const methodValid = body('declared.*.payment_method')
  .isIn(['CASH','TRANSFER','MP','QR','CHECK','OTHER'])
  .withMessage('payment_method inválido.');
const declaredAmountValid = body('declared.*.declared_amount')
  .isFloat({ min: 0 }).withMessage('declared_amount debe ser numérico >= 0.');

// ── Cajas ──────────────────────────────────────────────────────────────────
router.post('/',
  [
    body('opening_amount').isFloat({ min: 0 }).withMessage('opening_amount debe ser numérico >= 0.'),
    body('owner_user_id').optional({ nullable: true }).isUUID().withMessage('owner_user_id debe ser UUID.'),
    body('branch_id').optional({ nullable: true }).isUUID().withMessage('branch_id debe ser UUID.'),
    body('observations').optional({ nullable: true }).isString().isLength({ max: 500 }),
  ],
  validate,
  controller.open,
);

router.get('/active', controller.getActive);

router.get('/',
  [
    query('status').optional().isIn(['OPEN','PENDING_RECONCILIATION','CLOSED']),
    query('owner_user_id').optional().isUUID(),
    query('business_day_id').optional().isUUID(),
    query('business_date').optional().isISO8601(),
    query('branch_id').optional().isUUID(),
  ],
  validate,
  controller.getAll,
);

router.get('/:id', idParam, validate, controller.getById);
router.get('/:id/snapshot', idParam, validate, controller.snapshot);

router.post('/:id/close',
  [...idParam, declaredArray, methodValid, declaredAmountValid],
  validate,
  controller.close,
);

router.post('/:id/mark-pending',
  [...idParam, body('reason').isString().isLength({ min: 3, max: 500 })],
  validate,
  controller.markPending,
);

router.post('/:id/reconcile',
  [...idParam, declaredArray, methodValid, declaredAmountValid],
  validate,
  controller.reconcile,
);

// ── Drops ──────────────────────────────────────────────────────────────────
router.post('/:id/drops',
  [
    ...idParam,
    body('amount').isFloat({ gt: 0 }).withMessage('amount debe ser > 0.'),
    body('payment_method').isIn(['CASH','TRANSFER']),
    body('destination').optional({ nullable: true }).isString().isLength({ max: 120 }),
    body('destination_account_id').optional({ nullable: true }).isUUID()
      .withMessage('destination_account_id debe ser UUID.'),
    body('reason').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('receipt_reference').optional({ nullable: true }).isString().isLength({ max: 120 }),
  ],
  validate,
  controller.addDrop,
);

router.post('/:id/drops/:dropId/reverse',
  [
    ...idParam,
    param('dropId').isUUID().withMessage('dropId debe ser UUID.'),
    body('reason').isString().isLength({ min: 3, max: 500 }),
  ],
  validate,
  controller.reverseDrop,
);

module.exports = router;
