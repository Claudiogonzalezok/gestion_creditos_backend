const router     = require('express').Router();
const controller = require('./collectionAttempts.controller');
const { query }  = require('express-validator');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN', 'COLLECTOR', 'SELLER_COLLECTOR'),
  [
    query('collector_id').optional().isUUID().withMessage('collector_id debe ser un UUID válido.'),
    query('installment_id').optional().isUUID().withMessage('installment_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getAll
);

router.get('/:id',
  authorize('ADMIN', 'COLLECTOR', 'SELLER_COLLECTOR'),
  v.collectionAttempts.id, validate,
  controller.getById
);

router.post('/',
  authorize('ADMIN', 'COLLECTOR', 'SELLER_COLLECTOR'),
  v.collectionAttempts.create, validate,
  controller.create
);

module.exports = router;
