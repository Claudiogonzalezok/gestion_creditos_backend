const router = require("express").Router();
const controller = require("./test.controller");
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

module.exports = router;
