const router     = require('express').Router();
const controller = require('./productCategories.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN', 'SELLER', 'SELLER_COLLECTOR'),
  controller.getAll
);

router.post('/',
  authorize('ADMIN'),
  v.productCategories.create, validate,
  controller.create
);

router.patch('/:id/activate',
  authorize('ADMIN'),
  v.productCategories.id, validate,
  controller.activate
);

router.patch('/:id/deactivate',
  authorize('ADMIN'),
  v.productCategories.id, validate,
  controller.deactivate
);

module.exports = router;
