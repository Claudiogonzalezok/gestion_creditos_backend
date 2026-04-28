const router      = require('express').Router();
const controller  = require('./products.controller');
const v           = require('../../utils/validators');
const { query }   = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura — Admin y Vendedor
router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [
    query('status').optional().isIn(['ACTIVE','INACTIVE']).withMessage('status inválido.'),
    query('category_id').optional().isUUID().withMessage('category_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'), v.products.id, validate,
  controller.getById
);

// Alta y edición — solo Admin
router.post('/',
  authorize('ADMIN'), v.products.create, validate,
  controller.create
);
router.put('/:id',
  authorize('ADMIN'), v.products.update, validate,
  controller.update
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
