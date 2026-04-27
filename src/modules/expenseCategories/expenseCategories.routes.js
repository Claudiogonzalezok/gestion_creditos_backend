const router     = require('express').Router();
const controller = require('./expenseCategories.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN'),
  controller.getAll
);

router.post('/',
  authorize('ADMIN'),
  v.expenseCategories.create, validate,
  controller.create
);

router.patch('/:id/activate',
  authorize('ADMIN'),
  v.expenseCategories.id, validate,
  controller.activate
);

router.patch('/:id/deactivate',
  authorize('ADMIN'),
  v.expenseCategories.id, validate,
  controller.deactivate
);

module.exports = router;
