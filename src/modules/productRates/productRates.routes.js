const router     = require('express').Router();
const controller = require('./productRates.controller');
const v          = require('../../utils/validators');
const { query }  = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura: Admin y Vendedor (para cotizador interno)
router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [ query('product_id').optional().isUUID().withMessage('product_id debe ser un UUID válido.') ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN'), v.productRates.id, validate, controller.getById);

// Gestión: solo Admin
router.post('/',
  authorize('ADMIN'), v.productRates.create, validate, controller.create
);
router.put('/:id',
  authorize('ADMIN'), v.productRates.update, validate, controller.update
);
router.patch('/:id/deactivate',
  authorize('ADMIN'), v.productRates.id, validate, controller.deactivate
);
router.patch('/:id/activate',
  authorize('ADMIN'), v.productRates.id, validate, controller.activate
);

module.exports = router;
