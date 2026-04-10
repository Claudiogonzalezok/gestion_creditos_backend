const router     = require('express').Router();
const controller = require('./installments.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',    authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), controller.getAll);
router.get('/:id', authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'), v.penalties.id, validate, controller.getById);

router.patch('/:id/apply-penalty',
  authorize('ADMIN'), v.penalties.apply, validate, controller.applyPenalty
);
router.patch('/:id/waive-penalty',
  authorize('ADMIN'), v.penalties.id,   validate, controller.waivePenalty
);

module.exports = router;
