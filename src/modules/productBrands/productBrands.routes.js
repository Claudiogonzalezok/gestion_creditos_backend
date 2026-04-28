const router     = require('express').Router();
const controller = require('./productBrands.controller');
const { body, param } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  validate,
  controller.getAll
);

router.get('/:id',
  authorize('ADMIN','SELLER','SELLER_COLLECTOR'),
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.getById
);

router.post('/',
  authorize('ADMIN'),
  [
    body('name').trim()
      .notEmpty().withMessage('El nombre de la marca es obligatorio.')
      .isLength({ min: 2, max: 100 }).withMessage('El nombre debe tener entre 2 y 100 caracteres.'),
  ],
  validate,
  controller.create
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
