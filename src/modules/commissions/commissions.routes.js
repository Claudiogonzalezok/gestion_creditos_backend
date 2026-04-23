const router          = require('express').Router();
const controller      = require('./commissions.controller');
const { body, param, query } = require('express-validator');
const v               = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Comisiones — Admin ve todas, Vendedor/Cobrador solo las suyas
router.get('/',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('status').optional()
      .isIn(['PENDING','PAID','REVERSED'])
      .withMessage('status debe ser PENDING, PAID o REVERSED.'),
    query('user_id').optional()
      .isUUID().withMessage('user_id debe ser un UUID válido.'),
    query('week_start').optional()
      .isISO8601().withMessage('week_start debe ser una fecha válida en formato YYYY-MM-DD.'),
  ],
  validate,
  controller.getCommissions
);

// Resumen semanal para liquidación — solo Admin
router.get('/weekly-summary', authorize('ADMIN'), controller.getWeeklySummary);

// Liquidaciones
router.get('/liquidations',
  authorize('ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('user_id').optional()
      .isUUID().withMessage('user_id debe ser un UUID válido.'),
  ],
  validate,
  controller.getLiquidations
);
router.post('/liquidate',
  authorize('ADMIN'),
  v.commissions.liquidate, validate,
  controller.liquidate
);

// Sueldo fijo de cobrador — solo Admin
router.get('/salary/:userId',
  authorize('ADMIN'),
  [param('userId').isUUID().withMessage('El ID de usuario debe ser un UUID válido.')],
  validate,
  controller.getSalary
);
router.put('/salary/:userId',
  authorize('ADMIN'),
  [
    param('userId').isUUID().withMessage('El ID de usuario debe ser un UUID válido.'),
    body('weekly_amount')
      .custom(val => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0) throw new Error('El sueldo semanal debe ser un número mayor o igual a 0.');
        return true;
      }),
  ],
  validate,
  controller.setSalary
);

module.exports = router;
