const router     = require('express').Router();
const controller = require('./reports.controller');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');

router.use(authenticate);
router.use(authorize('ADMIN'));

router.get('/collection', controller.getCollectionReport);
router.get('/portfolio',  controller.getPortfolioReport);
router.get('/overdue',    controller.getOverdueReport);
router.get('/collectors', controller.getCollectorsReport);
router.get('/products',   controller.getProductsReport);

module.exports = router;
