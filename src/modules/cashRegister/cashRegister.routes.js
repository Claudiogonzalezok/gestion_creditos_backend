const router = require("express").Router();
const controller = require("./cashRegister.controller");
const { param, query, body } = require("express-validator");
const v = require("../../utils/validators");
const { validate } = require("../../middlewares/validate.middleware");
const {
  authenticate,
  authorize,
} = require("../../middlewares/auth.middleware");

router.use(authenticate);
router.use(authorize("ADMIN"));

router.get("/dashboard", controller.getDashboard);
router.get("/pre-close", controller.getPreClose);
router.get(
  "/sessions/:cash_session_id/movements",
  [
    param("cash_session_id")
      .isUUID()
      .withMessage("cash_session_id debe ser un UUID válido."),
  ],
  validate,
  controller.getSessionMovements,
);
router.get(
  "/",
  [
    query("date_from")
      .optional()
      .isISO8601()
      .withMessage(
        "date_from debe ser una fecha válida en formato YYYY-MM-DD.",
      ),
    query("date_to")
      .optional()
      .isISO8601()
      .withMessage("date_to debe ser una fecha válida en formato YYYY-MM-DD."),
    query("difference_status")
      .optional()
      .isIn(["EXACT", "SURPLUS", "SHORTAGE"])
      .withMessage("difference_status debe ser EXACT, SURPLUS o SHORTAGE."),
  ],
  validate,
  controller.getAll,
);
router.get(
  "/:id",
  [param("id").isUUID().withMessage("El ID debe ser un UUID válido.")],
  validate,
  controller.getById,
);
router.post(
  "/close",
  [
    ...v.cashRegister.close,
    body("force")
      .optional()
      .isBoolean()
      .withMessage("force debe ser true o false."),
  ],
  validate,
  controller.close,
);
router.post(
  "/conversions",
  [
    body("criteria")
      .isIn(["DAILY", "COMPANY"])
      .withMessage("criteria debe ser DAILY o COMPANY."),
    body("source_method")
      .isIn(["CASH", "TRANSFER"])
      .withMessage("source_method debe ser CASH o TRANSFER."),
    body("amount")
      .isFloat({ gt: 0 })
      .withMessage("amount debe ser un número mayor a 0."),
    body("notes")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 300 })
      .withMessage("notes no puede superar los 300 caracteres."),
    body("register_date")
      .optional({ nullable: true })
      .isISO8601()
      .withMessage(
        "register_date debe ser una fecha válida en formato YYYY-MM-DD.",
      ),
  ],
  validate,
  controller.createConversion,
);

module.exports = router;
