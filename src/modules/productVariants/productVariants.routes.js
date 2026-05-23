const router     = require('express').Router();
const controller = require('./productVariants.controller');
const v          = require('../../utils/validators');
const { query }  = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [
    query('product_id').optional().isUUID().withMessage('product_id debe ser un UUID válido.'),
    query('status').optional().isIn(['ACTIVE','INACTIVE']).withMessage('status inválido.'),
  ],
  validate,
  controller.getAll
);

router.get('/:id',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  v.productVariants.id, validate,
  controller.getById
);

router.post('/',
  authorize('ADMIN'),
  v.productVariants.create, validate,
  controller.create
);

router.post('/bulk',
  authorize('ADMIN'),
  v.productVariants.bulkCreate, validate,
  controller.createBulk
);

router.put('/:id',
  authorize('ADMIN'),
  v.productVariants.update, validate,
  controller.update
);

router.patch('/:id/deactivate',
  authorize('ADMIN'),
  v.productVariants.id, validate,
  controller.deactivate
);

router.patch('/:id/activate',
  authorize('ADMIN'),
  v.productVariants.id, validate,
  controller.activate
);

module.exports = router;
