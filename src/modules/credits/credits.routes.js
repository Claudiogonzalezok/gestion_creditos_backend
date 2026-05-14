const router              = require('express').Router();
const controller          = require('./credits.controller');
const paymentsController  = require('../payments/payments.controller');
const { query }           = require('express-validator');
const v                   = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// ── Cotizador público: sin autenticación (CU10) ───────────────
router.get('/simulate/options',   controller.getSimulateOptions);
router.get('/simulate/products',  controller.getSimulateProducts);
router.post('/simulate/all',      v.credits.simulateAll, validate, controller.simulateAll);
router.post('/simulate',          v.credits.simulate,    validate, controller.simulate);

// ── Rutas protegidas ──────────────────────────────────────────
router.use(authenticate);

router.get('/',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('status').optional()
      .isIn(['PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED'])
      .withMessage('status debe ser PENDING_APPROVAL, ACTIVE, SETTLED, REJECTED o EXPIRED.'),
    query('type').optional()
      .isIn(['SALE','LOAN'])
      .withMessage('type debe ser SALE o LOAN.'),
    query('customer_id').optional()
      .isUUID().withMessage('customer_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), v.credits.id, validate, controller.getById);

router.post('/', authorize('ADMIN','SELLER','SELLER_COLLECTOR'), v.credits.create, validate, controller.create);

router.patch('/:id/approve',
  authorize('ADMIN'), v.credits.approve, validate, controller.approve
);
router.patch('/:id/reject',
  authorize('ADMIN'), v.credits.reject, validate, controller.reject
);
router.patch('/:id/early-settlement',
  authorize('ADMIN'), v.credits.earlySettlement, validate, controller.earlySettlement
);
router.post('/:id/refinance',
  authorize('ADMIN'), v.credits.refinance, validate, controller.refinance
);

// Historial de cobros aprobados del crédito
router.get('/:creditId/payments',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  [require('express-validator').param('creditId').isUUID().withMessage('creditId debe ser un UUID válido.')],
  validate,
  paymentsController.getByCredit
);

module.exports = router;
