const router      = require('express').Router();
const controller  = require('./customers.controller');
const v           = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura — Admin, Vendedor y Cobrador
router.get('/',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  controller.getAll
);
router.get('/:id',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), v.customers.id, validate,
  controller.getById
);

// Alta — Admin, Vendedor y Vendedor-Cobrador
router.post('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'), v.customers.create, validate,
  controller.create
);

// Edición — solo Admin
router.put('/:id',
  authorize('ADMIN'), v.customers.update, validate,
  controller.update
);

// Activación / desactivación — solo Admin
router.patch('/:id/deactivate',
  authorize('ADMIN'), v.customers.id, validate,
  controller.deactivate
);
router.patch('/:id/activate',
  authorize('ADMIN'), v.customers.id, validate,
  controller.activate
);

// Portal público — solo Admin
router.patch('/:id/enable-portal',
  authorize('ADMIN'), v.customers.id, validate,
  controller.enablePortal
);
router.patch('/:id/disable-portal',
  authorize('ADMIN'), v.customers.id, validate,
  controller.disablePortal
);
router.patch('/:id/reset-portal-password',
  authorize('ADMIN'), v.customers.id, validate,
  controller.resetPortalPassword
);
router.patch('/:id/unlock-portal',
  authorize('ADMIN'), v.customers.id, validate,
  controller.unlockPortal
);

module.exports = router;
