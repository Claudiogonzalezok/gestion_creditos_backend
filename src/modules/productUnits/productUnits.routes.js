const router     = require('express').Router();
const controller = require('./productUnits.controller');
const { body, param, query } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [
    query('variant_id').optional().isUUID().withMessage('variant_id debe ser un UUID válido.'),
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

const unitCodeRule = (required = true) => {
  const base = body('unit_code').trim();
  const rule = required
    ? base.notEmpty().withMessage('El código de unidad es obligatorio.').bail()
    : base.optional();
  return rule
    .isLength({ min: 2, max: 100 }).withMessage('El código debe tener entre 2 y 100 caracteres.')
    .matches(/^[A-Za-z0-9\-_]+$/)
    .withMessage('El código solo puede contener letras, números, guiones (-) y guiones bajos (_).');
};

router.post('/',
  authorize('ADMIN'),
  [
    body('variant_id').isUUID().withMessage('La variante es obligatoria y debe ser un UUID válido.'),
    unitCodeRule(true),
    body('notes').optional({ nullable: true, checkFalsy: true }).trim()
      .isLength({ max: 500 }).withMessage('Las notas no pueden superar los 500 caracteres.'),
  ],
  validate,
  controller.create
);

router.post('/bulk',
  authorize('ADMIN'),
  [
    body('variant_id').isUUID().withMessage('La variante es obligatoria y debe ser un UUID válido.'),
    body('units').isArray({ min: 1 }).withMessage('Debe enviar al menos una unidad.'),
    body('units.*.unit_code').trim()
      .notEmpty().withMessage('Cada unidad debe tener un código.').bail()
      .isLength({ min: 2, max: 100 }).withMessage('El código debe tener entre 2 y 100 caracteres.')
      .matches(/^[A-Za-z0-9\-_]+$/)
      .withMessage('El código solo puede contener letras, números, guiones (-) y guiones bajos (_).'),
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
      .isLength({ min: 2, max: 100 }).withMessage('El código debe tener entre 2 y 100 caracteres.')
      .matches(/^[A-Za-z0-9\-_]+$/)
      .withMessage('El código solo puede contener letras, números, guiones (-) y guiones bajos (_).'),
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
