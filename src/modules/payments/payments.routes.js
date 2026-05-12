const router        = require('express').Router();
const controller    = require('./payments.controller');
const { query }     = require('express-validator');
const v             = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Listado y detalle — Admin ve todos, Cobrador solo los suyos (filtrado en service)
router.get('/',
  authorize('ADMIN','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('status').optional()
      .isIn(['PENDING','APPROVED','REJECTED'])
      .withMessage('status debe ser PENDING, APPROVED o REJECTED.'),
    query('collector_id').optional()
      .isUUID().withMessage('collector_id debe ser un UUID válido.'),
    query('installment_id').optional()
      .isUUID().withMessage('installment_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN','COLLECTOR','SELLER_COLLECTOR'), v.payments.id, validate, controller.getById);

// Registrar pre-carga de cobro
router.post('/',
  authorize('ADMIN','COLLECTOR','SELLER_COLLECTOR'),
  v.payments.create, validate,
  controller.create
);

// Aprobar / rechazar — solo Admin
router.patch('/:id/approve',
  authorize('ADMIN'), v.payments.id, validate, controller.approve
);
router.patch('/:id/reject',
  authorize('ADMIN'), v.payments.reject, validate, controller.reject
);

// Cobro directo (sin pre-carga) — solo Admin
router.post('/admin-direct',
  authorize('ADMIN'), v.payments.adminDirect, validate, controller.adminDirect
);

// Revertir cobro aprobado — solo Admin
router.post('/:id/reverse',
  authorize('ADMIN'), v.payments.reverse, validate, controller.reverse
);

module.exports = router;
