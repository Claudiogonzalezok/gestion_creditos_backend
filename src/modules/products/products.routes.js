const router      = require('express').Router();
const controller  = require('./products.controller');
const v           = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura — Admin y Vendedor
router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  controller.getAll
);
router.get('/:id',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'), v.products.id, validate,
  controller.getById
);

// Alta, edición y stock — solo Admin
router.post('/',
  authorize('ADMIN'), v.products.create, validate,
  controller.create
);
router.put('/:id',
  authorize('ADMIN'), v.products.update, validate,
  controller.update
);
router.patch('/:id/stock',
  authorize('ADMIN'), v.products.adjustStock, validate,
  controller.adjustStock
);
router.patch('/:id/deactivate',
  authorize('ADMIN'), v.products.id, validate,
  controller.deactivate
);
router.patch('/:id/activate',
  authorize('ADMIN'), v.products.id, validate,
  controller.activate
);

module.exports = router;
