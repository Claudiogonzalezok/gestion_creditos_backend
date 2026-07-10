const router     = require('express').Router();
const controller = require('./interestRates.controller');
const v          = require('../../utils/validators');
const { query }  = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura: Admin y Vendedor (para cotizador interno)
router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [ query('payment_frequency').optional().isIn(['DAILY','WEEKLY','BIWEEKLY','MONTHLY']).withMessage('payment_frequency inválido.') ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN'), v.interestRates.id, validate, controller.getById);

// Gestión: solo Admin
router.post('/',
  authorize('ADMIN'), v.interestRates.create, validate, controller.create
);
router.put('/:id',
  authorize('ADMIN'), v.interestRates.update, validate, controller.update
);
router.patch('/:id/deactivate',
  authorize('ADMIN'), v.interestRates.id, validate, controller.deactivate
);
router.patch('/:id/activate',
  authorize('ADMIN'), v.interestRates.id, validate, controller.activate
);

module.exports = router;
