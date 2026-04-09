const router     = require('express').Router();
const controller = require('./payments.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Listado y detalle — Admin ve todos, Cobrador solo los suyos (filtrado en service)
router.get('/',    authorize('ADMIN','COLLECTOR'), controller.getAll);
router.get('/:id', authorize('ADMIN','COLLECTOR'), v.payments.id, validate, controller.getById);

// Registrar pre-carga de cobro
router.post('/',
  authorize('ADMIN','COLLECTOR'),
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

module.exports = router;
