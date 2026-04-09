const router     = require('express').Router();
const controller = require('./collections.controller');
const v          = require('../../utils/validators');
const { validate }                = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);

// Listado — Admin y Cobrador (Cobrador filtrado por service)
router.get('/',    authorize('ADMIN','COLLECTOR'), controller.getAll);
router.get('/:id', authorize('ADMIN','COLLECTOR'), v.collections.id, validate, controller.getById);

// Generar planilla — solo Admin
router.post('/',
  authorize('ADMIN'),
  v.collections.generate, validate,
  controller.generate
);

module.exports = router;
