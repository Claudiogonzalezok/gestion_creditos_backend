const router      = require('express').Router();
const controller  = require('./users.controller');
const v           = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Rutas del propio usuario autenticado
router.patch('/me/change-password',
  v.users.changePassword, validate,
  controller.changePassword
);

// Rutas de administración (solo Admin)
router.get('/',
  authorize('ADMIN'),
  controller.getAll
);
router.get('/:id',
  authorize('ADMIN'), v.users.id, validate,
  controller.getById
);
router.post('/',
  authorize('ADMIN'), v.users.create, validate,
  controller.create
);
router.put('/:id',
  authorize('ADMIN'), v.users.update, validate,
  controller.update
);
router.patch('/:id/deactivate',
  authorize('ADMIN'), v.users.id, validate,
  controller.deactivate
);
router.patch('/:id/activate',
  authorize('ADMIN'), v.users.id, validate,
  controller.activate
);
router.patch('/:id/reset-password',
  authorize('ADMIN'), v.users.id, validate,
  controller.resetPassword
);
router.patch('/:id/unlock',
  authorize('ADMIN'), v.users.id, validate,
  controller.unlock
);

module.exports = router;
