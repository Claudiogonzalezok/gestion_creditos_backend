const router     = require('express').Router();
const controller = require('./credits.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// ── Cotizador público: sin autenticación (CU10) ───────────────
router.post('/simulate', v.credits.simulate, validate, controller.simulate);

// ── Rutas protegidas ──────────────────────────────────────────
router.use(authenticate);

router.get('/',    authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), controller.getAll);
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

module.exports = router;
