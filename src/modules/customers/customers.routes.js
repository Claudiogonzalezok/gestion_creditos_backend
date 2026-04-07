const router     = require('express').Router();
const { body }   = require('express-validator');
const controller = require('./customers.controller');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

const createRules = [
  body('full_name').trim().notEmpty().withMessage('El nombre completo es obligatorio.'),
  body('dni').trim().notEmpty().withMessage('El DNI es obligatorio.'),
  body('phone').optional({ nullable: true, checkFalsy: true }).trim(),
  body('email').optional({ nullable: true, checkFalsy: true })
    .isEmail().withMessage('El email debe ser válido.').normalizeEmail(),
  body('address').optional({ nullable: true, checkFalsy: true }).trim(),
  body('assigned_collector_id').optional({ nullable: true, checkFalsy: true })
    .isUUID().withMessage('El ID del cobrador debe ser un UUID válido.'),
];

const updateRules = [
  body('full_name').optional().trim().notEmpty().withMessage('El nombre no puede estar vacío.'),
  body('phone').optional({ nullable: true, checkFalsy: true }).trim(),
  body('email').optional({ nullable: true, checkFalsy: true })
    .isEmail().withMessage('El email debe ser válido.').normalizeEmail(),
  body('address').optional({ nullable: true, checkFalsy: true }).trim(),
  body('assigned_collector_id').optional({ nullable: true, checkFalsy: true })
    .isUUID().withMessage('El ID del cobrador debe ser un UUID válido.'),
];

// Lectura: Admin, Vendedor y Cobrador
router.get('/',    authorize('ADMIN','SELLER','COLLECTOR'), controller.getAll);
router.get('/:id', authorize('ADMIN','SELLER','COLLECTOR'), controller.getById);

// Alta y edición: Admin y Vendedor
router.post('/',   authorize('ADMIN','SELLER'), createRules, validate, controller.create);
router.put('/:id', authorize('ADMIN','SELLER'), updateRules, validate, controller.update);

// Activación / desactivación: solo Admin
router.patch('/:id/deactivate', authorize('ADMIN'), controller.deactivate);
router.patch('/:id/activate',   authorize('ADMIN'), controller.activate);

// Portal público: solo Admin
router.patch('/:id/enable-portal',          authorize('ADMIN'), controller.enablePortal);
router.patch('/:id/disable-portal',         authorize('ADMIN'), controller.disablePortal);
router.patch('/:id/reset-portal-password',  authorize('ADMIN'), controller.resetPortalPassword);
router.patch('/:id/unlock-portal',          authorize('ADMIN'), controller.unlockPortal);

module.exports = router;
