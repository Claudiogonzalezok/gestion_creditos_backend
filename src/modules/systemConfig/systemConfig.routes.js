const router     = require('express').Router();
const controller = require('./systemConfig.controller');
const { body }   = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate, authorize('ADMIN'));

router.get('/',        controller.getAll);
router.get('/:key',    controller.getByKey);
router.put('/:key',
  body('value').notEmpty().withMessage('El valor es obligatorio.'),
  validate,
  controller.update
);
router.post('/:key/reset', controller.resetToDefault);

module.exports = router;
