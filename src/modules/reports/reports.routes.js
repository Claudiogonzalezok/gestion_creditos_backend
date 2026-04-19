const router     = require('express').Router();
const controller = require('./reports.controller');
const { query }  = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

const dateRangeRules = [
  query('date_from')
    .notEmpty().withMessage('El parámetro date_from es obligatorio.').bail()
    .isISO8601().withMessage('date_from debe ser una fecha válida en formato YYYY-MM-DD.'),
  query('date_to')
    .notEmpty().withMessage('El parámetro date_to es obligatorio.').bail()
    .isISO8601().withMessage('date_to debe ser una fecha válida en formato YYYY-MM-DD.'),
  query('date_from').custom((val, { req }) => {
    if (new Date(val) > new Date(req.query.date_to))
      throw new Error('date_from no puede ser posterior a date_to.');
    return true;
  }),
];

router.get('/collection', dateRangeRules, validate, controller.getCollectionReport);
router.get('/portfolio',  controller.getPortfolioReport);
router.get('/overdue',    controller.getOverdueReport);
router.get('/collectors', dateRangeRules, validate, controller.getCollectorsReport);
router.get('/products',   controller.getProductsReport);

module.exports = router;
