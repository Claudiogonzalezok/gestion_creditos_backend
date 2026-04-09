const router     = require('express').Router();
const controller = require('./commissions.controller');
const { body, param } = require('express-validator');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Comisiones — Admin ve todas, Vendedor/Cobrador solo las suyas
router.get('/', authorize('ADMIN','SELLER','COLLECTOR'), controller.getCommissions);

// Resumen semanal para liquidación — solo Admin
router.get('/weekly-summary', authorize('ADMIN'), controller.getWeeklySummary);

// Liquidaciones
router.get('/liquidations',
  authorize('ADMIN','SELLER','COLLECTOR'),
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
      .isFloat({ min: 0 })
      .withMessage('El sueldo semanal debe ser un número mayor o igual a 0.'),
  ],
  validate,
  controller.setSalary
);

module.exports = router;
