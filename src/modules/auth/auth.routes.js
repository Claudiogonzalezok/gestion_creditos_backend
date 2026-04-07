const router     = require('express').Router();
const { body }   = require('express-validator');
const controller = require('./auth.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate, authenticatePortal } = require('../../middlewares/auth.middleware');

const loginRules = [
  body('dni').trim().notEmpty().withMessage('El DNI es obligatorio.'),
  body('password').notEmpty().withMessage('La contraseña es obligatoria.'),
];

// Sistema interno
router.post('/login',         loginRules, validate, controller.loginInternal);
router.post('/logout',        authenticate, controller.logout);
router.get('/me',             authenticate, controller.me);

// Portal público
router.post('/portal/login',  loginRules, validate, controller.loginPortal);
router.post('/portal/logout', authenticatePortal, controller.logoutPortal);

module.exports = router;
