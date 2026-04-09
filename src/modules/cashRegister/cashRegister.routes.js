const router     = require('express').Router();
const controller = require('./cashRegister.controller');
const { param }  = require('express-validator');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/dashboard', controller.getDashboard);
router.get('/',          controller.getAll);
router.get('/:id',
  [param('id').isUUID().withMessage('El ID debe ser un UUID válido.')],
  validate,
  controller.getById
);
router.post('/close',
  v.cashRegister.close, validate,
  controller.close
);

module.exports = router;
