const router        = require('express').Router();
const controller    = require('./collections.controller');
const { query }     = require('express-validator');
const v             = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Listado — Admin y Cobrador (Cobrador filtrado por service)
router.get('/',
  authorize('ADMIN','COLLECTOR','SELLER_COLLECTOR'),
  [
    query('collector_id').optional()
      .isUUID().withMessage('collector_id debe ser un UUID válido.'),
    query('date').optional()
      .isISO8601().withMessage('date debe ser una fecha válida en formato YYYY-MM-DD.'),
  ],
  validate,
  controller.getAll
);
router.get('/:id', authorize('ADMIN','COLLECTOR','SELLER_COLLECTOR'), v.collections.id, validate, controller.getById);
router.patch('/:id/send', authorize('ADMIN'), v.collections.id, validate, controller.send);

// Generar planilla — solo Admin
router.post('/',
  authorize('ADMIN'),
  v.collections.generate, validate,
  controller.generate
);

module.exports = router;
