const router        = require('express').Router();
const controller    = require('./cashRegister.controller');
const { param, query, body } = require('express-validator');
const v             = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/dashboard', controller.getDashboard);
router.get('/',
  [
    query('difference_status')
      .optional()
      .isIn(['EXACT', 'SURPLUS', 'SHORTAGE'])
      .withMessage('difference_status debe ser EXACT, SURPLUS o SHORTAGE.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id',
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.getById
);
router.post('/close',
  [
    ...v.cashRegister.close,
    body('force').optional().isBoolean().withMessage('force debe ser true o false.'),
  ],
  validate,
  controller.close
);

module.exports = router;
