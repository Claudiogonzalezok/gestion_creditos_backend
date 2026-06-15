const router = require("express").Router();
const controller = require("./cashAccounts.controller");
const { param, query, body } = require("express-validator");
const { validate } = require("../../middlewares/validate.middleware");
const {
  authenticate,
  authorize,
} = require("../../middlewares/auth.middleware");

// Toda la API de Caja General es ADMIN-only: es tesorería, no caja operativa.
router.use(authenticate);
router.use(authorize("ADMIN"));

const idParam = [
  param("id").isUUID().withMessage("El id debe ser un UUID válido."),
];

// IMP-6: SALARY_PAYMENT excluido del POST público (única vía:
// commissions.liquidate). Sí se acepta como filtro de listado.
const PUBLIC_TYPES = ["SUPPLIER_PAYMENT", "EXPENSE", "ADJUSTMENT"];
const ALL_TYPES = ["DROP_IN", "SALARY_PAYMENT", ...PUBLIC_TYPES];

router.get("/", controller.getAll);

router.get("/:id", idParam, validate, controller.getById);

router.get("/:id/balance", idParam, validate, controller.getBalance);

router.get("/:id/audit-balance", idParam, validate, controller.getAuditBalance);

router.get(
  "/:id/movements",
  [
    ...idParam,
    query("movement_type")
      .optional()
      .isIn(ALL_TYPES)
      .withMessage(`movement_type debe ser uno de: ${ALL_TYPES.join(", ")}.`),
    query("direction").optional().isIn(["IN", "OUT"]),
    query("from").optional().isISO8601().withMessage("from debe ser ISO8601."),
    query("to").optional().isISO8601().withMessage("to debe ser ISO8601."),
    query("page").optional().isInt({ min: 1 }),
    query("page_size").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  controller.listMovements,
);

router.post(
  "/:id/movements",
  [
    ...idParam,
    body("movement_type")
      .isIn(PUBLIC_TYPES)
      .withMessage(
        `movement_type debe ser uno de: ${PUBLIC_TYPES.join(", ")}.`,
      ),
    body("direction")
      .optional({ nullable: true })
      .isIn(["IN", "OUT"])
      .withMessage("direction debe ser IN u OUT (solo aplica a ADJUSTMENT)."),
    body("amount")
      .optional({ nullable: true })
      .isFloat({ gt: 0 })
      .withMessage("amount debe ser > 0."),
    body("amount_cash")
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage("amount_cash debe ser >= 0."),
    body("amount_transfer")
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage("amount_transfer debe ser >= 0."),
    body("description")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 1000 }),
    body("beneficiary_name")
      .optional({ nullable: true })
      .isString()
      .isLength({ max: 200 }),
    body().custom((b) => {
      const has = (v) =>
        v !== undefined && v !== null && String(v).trim() !== "";
      const hasSplit = has(b.amount_cash) || has(b.amount_transfer);
      if (!hasSplit) {
        if (!has(b.amount)) throw new Error("amount es obligatorio.");
        return true;
      }
      if (b.movement_type !== "ADJUSTMENT" || b.direction !== "IN") {
        throw new Error(
          "amount_cash/amount_transfer solo aplican a ADJUSTMENT IN.",
        );
      }
      const cash = parseFloat(b.amount_cash) || 0;
      const transfer = parseFloat(b.amount_transfer) || 0;
      if (cash <= 0 || transfer <= 0) {
        throw new Error(
          "Para un ajuste mixto ambos importes deben ser mayores a 0.",
        );
      }
      if (
        has(b.amount) &&
        Math.round(parseFloat(b.amount) * 100) !==
          Math.round((cash + transfer) * 100)
      ) {
        throw new Error(
          "amount debe coincidir con amount_cash + amount_transfer.",
        );
      }
      return true;
    }),
  ],
  validate,
  controller.registerMovement,
);

module.exports = router;
