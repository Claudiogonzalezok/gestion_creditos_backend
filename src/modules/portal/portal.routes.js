const router     = require('express').Router();
const controller = require('./portal.controller');
const { param }  = require('express-validator');
const { validate }            = require('../../middlewares/validate.middleware');
const { authenticatePortal }  = require('../../middlewares/auth.middleware');

router.use(authenticatePortal);

// Resumen de cuenta del cliente autenticado
router.get('/me', controller.getAccountSummary);

// Lista de créditos
router.get('/credits', controller.getCredits);

// Detalle de un crédito con cronograma de cuotas
router.get('/credits/:id',
  [param('id').isUUID().withMessage('El ID de crédito debe ser un UUID válido.')],
  validate,
  controller.getCreditById
);

module.exports = router;
