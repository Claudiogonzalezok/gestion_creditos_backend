const router     = require('express').Router();
const controller = require('./productUnits.controller');
const { body, param, query } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Lectura — Admin, Seller, SellerCollector
router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [
    query('product_id').optional().isUUID().withMessage('product_id debe ser un UUID válido.'),
    query('status').optional()
      .isIn(['AVAILABLE','RESERVED','SOLD','INACTIVE'])
      .withMessage('status inválido.'),
  ],
  validate,
  controller.getAll
);

router.get('/:id',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.getById
);

// Escritura — solo Admin
router.post('/',
  authorize('ADMIN'),
  [
    body('product_id').isUUID().withMessage('El producto es obligatorio y debe ser un UUID válido.'),
    body('unit_code').trim().notEmpty().withMessage('El código de unidad es obligatorio.')
      .isLength({ max: 100 }).withMessage('El código no puede superar los 100 caracteres.'),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las notas no pueden superar los 500 caracteres.'),
  ],
  validate,
  controller.create
);

router.post('/bulk',
  authorize('ADMIN'),
  [
    body('product_id').isUUID().withMessage('El producto es obligatorio y debe ser un UUID válido.'),
    body('units').isArray({ min: 1 }).withMessage('Debe enviar al menos una unidad.'),
    body('units.*.unit_code').trim().notEmpty().withMessage('Cada unidad debe tener un código.')
      .isLength({ max: 100 }).withMessage('El código no puede superar los 100 caracteres.'),
    body('units.*.notes').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las notas no pueden superar los 500 caracteres.'),
  ],
  validate,
  controller.createBulk
);

router.patch('/:id',
  authorize('ADMIN'),
  [
    param('id').isUUID().withMessage('El ID debe ser un UUID válido.'),
    body('unit_code').optional().trim()
      .isLength({ min: 1, max: 100 }).withMessage('El código debe tener entre 1 y 100 caracteres.'),
    body('notes').optional({ nullable: true }).trim()
      .isLength({ max: 500 }).withMessage('Las notas no pueden superar los 500 caracteres.'),
  ],
  validate,
  controller.update
);

router.patch('/:id/deactivate',
  authorize('ADMIN'),
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.deactivate
);

router.patch('/:id/activate',
  authorize('ADMIN'),
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.activate
);

module.exports = router;
