const router = require("express").Router();
const controller = require("./reports.controller");
const { query } = require("express-validator");
const { validate } = require("../../middlewares/validate.middleware");
const {
  authenticate,
  authorize,
} = require("../../middlewares/auth.middleware");

router.use(authenticate);
router.use(authorize("ADMIN"));

const dateRangeRules = [
  query("date_from")
    .notEmpty()
    .withMessage("El parámetro date_from es obligatorio.")
    .bail()
    .isISO8601()
    .withMessage("date_from debe ser una fecha válida en formato YYYY-MM-DD."),
  query("date_to")
    .notEmpty()
    .withMessage("El parámetro date_to es obligatorio.")
    .bail()
    .isISO8601()
    .withMessage("date_to debe ser una fecha válida en formato YYYY-MM-DD."),
  query("date_from").custom((val, { req }) => {
    if (new Date(val) > new Date(req.query.date_to))
      throw new Error("date_from no puede ser posterior a date_to.");
    return true;
  }),
];

// Existentes
router.get(
  "/collection",
  dateRangeRules,
  validate,
  controller.getCollectionReport,
);
router.get("/portfolio", controller.getPortfolioReport);
router.get("/overdue", controller.getOverdueReport);
router.get(
  "/collectors",
  dateRangeRules,
  validate,
  controller.getCollectorsReport,
);
router.get("/sellers", dateRangeRules, validate, controller.getSellersReport);

router.get(
  "/products",
  [
    query("stock_threshold")
      .optional()
      .isInt({ min: 0 })
      .withMessage("stock_threshold debe ser un entero mayor o igual a 0."),
  ],
  validate,
  controller.getProductsReport,
);

// Nuevos
router.get("/summary", controller.getSummaryReport);

router.get(
  "/upcoming",
  [
    query("days")
      .optional()
      .isInt({ min: 1, max: 90 })
      .withMessage("days debe ser un entero entre 1 y 90."),
  ],
  validate,
  controller.getUpcomingReport,
);

router.get("/alerts/overdue-48h", controller.getPaymentsOverdue48h);
router.get(
  "/cash-conversions",
  dateRangeRules,
  validate,
  controller.getCashConversionsReport,
);
router.get(
  "/cash-movements",
  [
    query("cash_session_id")
      .notEmpty()
      .withMessage("El parámetro cash_session_id es obligatorio.")
      .bail()
      .isUUID()
      .withMessage("cash_session_id debe ser un UUID válido."),
  ],
  validate,
  controller.getCashMovementsReport,
);

module.exports = router;
