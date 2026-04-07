const router     = require('express').Router();
const { body }   = require('express-validator');
const controller = require('./users.controller');
const { validate }              = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

// Todas las rutas requieren autenticación
router.use(authenticate);

const createRules = [
  body('full_name').trim().notEmpty().withMessage('El nombre completo es obligatorio.'),
  body('dni').trim().notEmpty().withMessage('El DNI es obligatorio.'),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().withMessage('El email debe ser válido.').normalizeEmail(),
  body('role')
    .isIn(['ADMIN','SELLER','COLLECTOR'])
    .withMessage('El rol debe ser ADMIN, SELLER o COLLECTOR.'),
];

const updateRules = [
  body('full_name').optional().trim().notEmpty().withMessage('El nombre no puede estar vacío.'),
  body('dni').optional().trim().notEmpty().withMessage('El DNI no puede estar vacío.'),
  body('email').optional().isEmail().withMessage('El email debe ser válido.').normalizeEmail(),
  body('role').optional()
    .isIn(['ADMIN','SELLER','COLLECTOR'])
    .withMessage('El rol debe ser ADMIN, SELLER o COLLECTOR.'),
];

const changePasswordRules = [
  body('current_password').notEmpty().withMessage('La contraseña actual es obligatoria.'),
  body('new_password')
    .isLength({ min: 8 }).withMessage('La nueva contraseña debe tener al menos 8 caracteres.')
    .matches(/\d/).withMessage('La nueva contraseña debe contener al menos un número.'),
];

// ── Rutas del propio usuario autenticado ──────────────────────
router.patch('/me/change-password', changePasswordRules, validate, controller.changePassword);

// ── Rutas de administración (solo Admin) ──────────────────────
router.get('/',                 authorize('ADMIN'), controller.getAll);
router.get('/:id',              authorize('ADMIN'), controller.getById);
router.post('/',                authorize('ADMIN'), createRules, validate, controller.create);
router.put('/:id',              authorize('ADMIN'), updateRules, validate, controller.update);
router.patch('/:id/deactivate', authorize('ADMIN'), controller.deactivate);
router.patch('/:id/activate',   authorize('ADMIN'), controller.activate);
router.patch('/:id/reset-password', authorize('ADMIN'), controller.resetPassword);
router.patch('/:id/unlock',     authorize('ADMIN'), controller.unlock);

module.exports = router;
