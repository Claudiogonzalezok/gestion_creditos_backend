const router        = require('express').Router();
const controller    = require('./businessDays.controller');
const { param, query, body } = require('express-validator');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/',
  [
    query('status').optional().isIn(['OPEN','READY_TO_CLOSE','CLOSED','AUDITED']),
    query('branch_id').optional().isUUID(),
    query('date_from').optional().isISO8601(),
    query('date_to').optional().isISO8601(),
  ],
  validate,
  controller.getAll,
);

router.get('/:id',
  [param('id').isUUID()],
  validate,
  controller.getById,
);

router.post('/:id/close',
  [
    param('id').isUUID(),
    body('observations').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  validate,
  controller.close,
);

router.post('/:id/force-close',
  [
    param('id').isUUID(),
    body('reason').isString().isLength({ min: 3, max: 1000 })
      .withMessage('reason es obligatorio (3..1000 chars) para forzar el cierre.'),
  ],
  validate,
  controller.forceClose,
);

router.post('/:id/audit',
  [
    param('id').isUUID(),
    body('observations').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  ],
  validate,
  controller.audit,
);

module.exports = router;
