const router = require('express').Router();
const { query } = require('express-validator');
const controller = require('./holidays.controller');
const v = require('../../utils/validators');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate, authorize('ADMIN'));

router.get('/',
  [
    query('type').optional().isIn(['EXTRAORDINARY', 'NATIONAL', 'LOCAL', 'BANKING']).withMessage('type inválido.'),
    query('active').optional().isBoolean().withMessage('active debe ser true o false.'),
    query('affects_due_dates').optional().isBoolean().withMessage('affects_due_dates debe ser true o false.'),
  ],
  validate,
  controller.getAll,
);

router.get('/:id', v.holidays.id, validate, controller.getById);
router.post('/', v.holidays.create, validate, controller.create);
router.post('/duplicate-year/preview', v.holidays.duplicateYear, validate, controller.previewDuplicateYear);
router.post('/duplicate-year', v.holidays.duplicateYear, validate, controller.duplicateYear);
router.put('/:id', v.holidays.update, validate, controller.update);

module.exports = router;
