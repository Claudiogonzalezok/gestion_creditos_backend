const router     = require('express').Router();
const { query }  = require('express-validator');
const controller = require('./cronLogs.controller');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// Todas las rutas del módulo son admin-only.
router.use(authenticate, authorize('ADMIN'));

router.get(
  '/',
  query('job_name').optional().isString().isLength({ max: 100 }),
  query('since').optional().isISO8601().withMessage('since debe ser fecha o timestamp ISO8601.'),
  query('limit').optional().isInt({ min: 1, max: 500 }).toInt()
    .withMessage('limit debe ser entero entre 1 y 500.'),
  validate,
  controller.list
);

router.get('/summary', controller.summary);

module.exports = router;
