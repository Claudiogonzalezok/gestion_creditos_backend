const router     = require('express').Router();
const controller = require('./expenses.controller');
const { query }  = require('express-validator');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

router.get('/',
  authorize('ADMIN'),
  [
    query('date_from').optional().isISO8601().withMessage('date_from debe ser una fecha válida.'),
    query('date_to').optional().isISO8601().withMessage('date_to debe ser una fecha válida.'),
    ...v.paginationRules,
  ],
  validate,
  controller.getAll
);

router.get('/:id',
  authorize('ADMIN'),
  v.expenses.id, validate,
  controller.getById
);

router.post('/',
  authorize('ADMIN'),
  v.expenses.create, validate,
  controller.create
);

router.delete('/:id',
  authorize('ADMIN'),
  v.expenses.id, validate,
  controller.remove
);

module.exports = router;
