const router     = require('express').Router();
const { body }   = require('express-validator');
const controller = require('./auth.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate, authenticatePortal } = require('../../middlewares/auth.middleware');

const loginRules = [
  body('dni').trim().notEmpty().withMessage('El DNI es obligatorio.'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria.'),
];

const changePortalPasswordRules = [
  body('current_password')
    .notEmpty().withMessage('La contraseña actual es obligatoria.'),
  body('new_password')
    .notEmpty().withMessage('La nueva contraseña es obligatoria.')
    .isLength({ min: 6 }).withMessage('La nueva contraseña debe tener al menos 6 caracteres.')
    .custom((val, { req }) => {
      if (val === req.body.current_password)
        throw new Error('La nueva contraseña no puede ser igual a la actual.');
      return true;
    }),
];

// Sistema interno
router.post('/login',         loginRules, validate, controller.loginInternal);
router.post('/logout',        authenticate, controller.logout);
router.get('/me',             authenticate, controller.me);

// Portal público
router.post('/portal/login',           loginRules, validate, controller.loginPortal);
router.post('/portal/logout',          authenticatePortal, controller.logoutPortal);
router.post('/portal/change-password', authenticatePortal, changePortalPasswordRules, validate, controller.changePortalPassword);

module.exports = router;
