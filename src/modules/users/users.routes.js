const router      = require('express').Router();
const controller  = require('./users.controller');
const v           = require('../../utils/validators');
const { query }   = require('express-validator');
const { validate }                                            = require('../../middlewares/validate.middleware');
const { authenticate, authenticateAllowTemp, authorize }      = require('../../middlewares/auth.middleware');

// ── Ruta con middleware propio (fuera del authenticate global) ─
// authenticateAllowTemp permite el acceso aunque la contraseña sea temporal,
// para que el usuario obligatoriamente pueda cambiarla.
router.patch('/me/change-password',
  authenticateAllowTemp, v.users.changePassword, validate,
  controller.changePassword
);

// ── Todas las rutas siguientes requieren token válido y contraseña no temporal
router.use(authenticate);

// Perfil propio del usuario logueado
router.get('/me', controller.getMe);
router.patch('/me', v.users.updateMe, validate, controller.updateMe);

// Rutas de administración (solo Admin)
router.get('/',
  authorize('ADMIN'),
  [
    query('role').optional().isIn(['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR']).withMessage('role inválido.'),
    query('roles').optional().custom((value) => {
      const valid = ['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'];
      const tokens = String(value).split(',').map((r) => r.trim()).filter(Boolean);
      if (!tokens.length || tokens.some((t) => !valid.includes(t)))
        throw new Error('roles inválido. Use una lista separada por comas de roles válidos.');
      return true;
    }),
    query('status').optional().isIn(['ACTIVE','INACTIVE']).withMessage('status inválido.'),
  ],
  validate,
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
