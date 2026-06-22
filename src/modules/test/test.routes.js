const router = require("express").Router();
const controller = require("./test.controller");
const v = require("../../utils/validators");
const { validate } = require("../../middlewares/validate.middleware");
const {
  authenticate,
  authorize,
} = require("../../middlewares/auth.middleware");
const response = require("../../utils/response");

/**
 * Guarda de entorno: este módulo expone utilidades destructivas SOLO cuando
 * `ENABLE_TEST_ROUTES=true` (no se usa `NODE_ENV==='test'` porque `dev:e2e`
 * no setea esa variable). Cualquier otro entorno recibe 404.
 */
router.use((req, res, next) => {
  if (process.env.ENABLE_TEST_ROUTES !== "true") return response.notFound(res);
  next();
});

router.use(authenticate);
router.use(authorize("ADMIN"));

router.delete("/business-days/today", controller.resetToday);
router.patch(
  "/installments/:id/force-due-date",
  v.test.forceInstallmentDueDate,
  validate,
  controller.forceInstallmentDueDate,
);
router.delete(
  "/commission-liquidations/:userId",
  v.test.resetCommissionLiquidations,
  validate,
  controller.resetCommissionLiquidations,
);
router.patch(
  "/credits/:id/force-created-at",
  v.test.forceCreditCreatedAt,
  validate,
  controller.forceCreditCreatedAt,
);

module.exports = router;
