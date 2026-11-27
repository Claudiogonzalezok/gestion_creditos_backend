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
const {
  PUBLIC_MOVEMENT_TYPES: PUBLIC_TYPES,
  ALL_MOVEMENT_TYPES: ALL_TYPES,
} = require("./cashAccounts.constants");
// Tipos públicos que siempre son egreso (ADJUSTMENT depende de direction).
const OUT_TYPES = ["SUPPLIER_PAYMENT", "EXPENSE"];

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
      .isFloat({ gt: 0, max: 99999999 })
      .withMessage("amount debe ser > 0 y <= 99999999."),
    body("amount_cash")
      .optional({ nullable: true })
      .isFloat({ min: 0, max: 99999999 })
      .withMessage("amount_cash debe ser >= 0 y <= 99999999."),
    body("amount_transfer")
      .optional({ nullable: true })
      .isFloat({ min: 0, max: 99999999 })
      .withMessage("amount_transfer debe ser >= 0 y <= 99999999."),
    body("payment_method")
      .optional({ nullable: true })
      .isIn(["CASH", "TRANSFER"])
      .withMessage("payment_method debe ser CASH o TRANSFER."),
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
      // Todo egreso (tipos OUT o ADJUSTMENT OUT) debe declarar su medio.
      const isOut =
        OUT_TYPES.includes(b.movement_type) ||
        (b.movement_type === "ADJUSTMENT" && b.direction === "OUT");
      if (hasSplit && has(b.payment_method)) {
        throw new Error(
          "Enviá payment_method o amount_cash/amount_transfer, no ambos.",
        );
      }
      if (!hasSplit) {
        if (!has(b.amount)) throw new Error("amount es obligatorio.");
        if (isOut && !has(b.payment_method)) {
          throw new Error(
            "payment_method es obligatorio en egresos (CASH o TRANSFER), o enviá amount_cash/amount_transfer.",
          );
        }
        return true;
      }
      // Desde #93 el desglose aplica también a egresos (OUT): cada medio se
      // valida contra su propio saldo en el service.
      const cash = parseFloat(b.amount_cash) || 0;
      const transfer = parseFloat(b.amount_transfer) || 0;
      if (cash < 0 || transfer < 0 || cash + transfer <= 0) {
        throw new Error(
          "amount_cash y amount_transfer deben ser >= 0 y al menos uno mayor a 0.",
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
