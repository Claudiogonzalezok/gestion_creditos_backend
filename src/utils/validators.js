const { body, param, query } = require("express-validator");

// ============================================================
//  REGLAS REUTILIZABLES — bloques atómicos que se combinan
// ============================================================

// ── Strings generales ─────────────────────────────────────────
const isString = (
  field,
  label,
  { min = 1, max = 150, required = true } = {},
) => {
  let rule = body(field).trim();
  if (!required) {
    rule = rule.optional({ nullable: true, checkFalsy: true });
  } else {
    rule = rule.notEmpty().withMessage(`${label} es obligatorio.`).bail();
  }
  return rule
    .isString()
    .withMessage(`${label} debe ser texto.`)
    .isLength({ min, max })
    .withMessage(`${label} debe tener entre ${min} y ${max} caracteres.`);
};

// ── DNI ───────────────────────────────────────────────────────
const isDni = (field = "dni", required = true) => {
  let rule = body(field).trim();
  if (!required) {
    rule = rule.optional({ nullable: true, checkFalsy: true });
  } else {
    rule = rule.notEmpty().withMessage("El DNI es obligatorio.").bail();
  }
  return rule
    .isString()
    .withMessage("El DNI debe ser texto.")
    .isLength({ min: 7, max: 9 })
    .withMessage("El DNI debe tener entre 7 y 9 caracteres.")
    .matches(/^\d+$/)
    .withMessage("El DNI solo puede contener números.");
};

// ── Email ─────────────────────────────────────────────────────
const isEmail = (required = false) => {
  let rule = body("email").trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isEmail()
    .withMessage("El email debe tener un formato válido.")
    .isLength({ max: 150 })
    .withMessage("El email no puede superar los 150 caracteres.")
    .normalizeEmail();
};

// ── Teléfono ──────────────────────────────────────────────────
const isPhone = (required = false) => {
  let rule = body("phone").trim();
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isString()
    .withMessage("El teléfono debe ser texto.")
    .isLength({ min: 6, max: 30 })
    .withMessage("El teléfono debe tener entre 6 y 30 caracteres.")
    .matches(/^\d+$/)
    .withMessage("El telefono solo puede contener números.");
};

// ── UUID ──────────────────────────────────────────────────────
const isUUID = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isUUID()
    .withMessage(`${label} debe ser un identificador UUID válido.`);
};

const isUUIDParam = (field, label) =>
  param(field)
    .isUUID()
    .withMessage(`${label} debe ser un identificador UUID válido.`);

// ── Enum ──────────────────────────────────────────────────────
const isEnum = (field, label, values, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isIn(values)
    .withMessage(
      `${label} debe ser uno de los siguientes valores: ${values.join(", ")}.`,
    );
};

// ── Numérico positivo ─────────────────────────────────────────
const isPositiveNumber = (
  field,
  label,
  { min = 0.01, max = 99999999, required = true } = {},
) => {
  let rule = body(field);
  if (!required) {
    rule = rule.optional();
  } else {
    rule = rule.notEmpty().withMessage(`${label} es obligatorio.`).bail();
  }
  return rule.custom((val) => {
    const n = parseFloat(val);
    if (isNaN(n) || n < min || n > max)
      throw new Error(`${label} debe ser un número entre ${min} y ${max}.`);
    return true;
  });
};

// ── Entero positivo ───────────────────────────────────────────
const isPositiveInt = (
  field,
  label,
  { min = 1, max = 9999, required = true } = {},
) => {
  let rule = body(field);
  if (!required) {
    rule = rule.optional();
  } else {
    rule = rule.notEmpty().withMessage(`${label} es obligatorio.`).bail();
  }
  return rule
    .isInt({ min, max })
    .withMessage(`${label} debe ser un número entero entre ${min} y ${max}.`);
};

// ── Contraseña ────────────────────────────────────────────────
const isPassword = (field = "password", label = "La contraseña") => {
  return body(field)
    .notEmpty()
    .withMessage(`${label} es obligatoria.`)
    .isLength({ min: 8, max: 100 })
    .withMessage(`${label} debe tener entre 8 y 100 caracteres.`)
    .matches(/\d/)
    .withMessage(`${label} debe contener al menos un número.`);
};

// ── Fecha ─────────────────────────────────────────────────────
const isDate = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional({ nullable: true, checkFalsy: true });
  return rule
    .isISO8601({ strict: true })
    .withMessage(`${label} debe ser una fecha válida en formato YYYY-MM-DD.`)
    .trim();
};

// ── Booleano ──────────────────────────────────────────────────
const isBool = (field, label, required = true) => {
  let rule = body(field);
  if (!required) rule = rule.optional();
  return rule
    .isBoolean()
    .withMessage(`${label} debe ser verdadero o falso.`)
    .toBoolean();
};

// ── Query param: paginación ───────────────────────────────────
const paginationRules = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("La página debe ser un número entero mayor a 0.")
    .toInt(),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("El límite debe ser entre 1 y 100.")
    .toInt(),
];

// ============================================================
//  VALIDADORES COMPLETOS POR MÓDULO
// ============================================================

// ── USERS ─────────────────────────────────────────────────────
const users = {
  create: [
    isString("full_name", "El nombre completo", { min: 3, max: 150 }),
    isDni("dni"),
    isEmail(false),
    body("address")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage("La dirección no puede superar los 255 caracteres."),
    isEnum("role", "El rol", [
      "ADMIN",
      "SELLER",
      "COLLECTOR",
      "SELLER_COLLECTOR",
    ]),
  ],
  update: [
    isUUIDParam("id", "El ID de usuario"),
    isString("full_name", "El nombre completo", {
      min: 3,
      max: 150,
      required: false,
    }),
    isDni("dni", false),
    isEmail(false),
    body("address")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage("La dirección no puede superar los 255 caracteres."),
    isEnum(
      "role",
      "El rol",
      ["ADMIN", "SELLER", "COLLECTOR", "SELLER_COLLECTOR"],
      false,
    ),
  ],
  changePassword: [
    body("current_password")
      .notEmpty()
      .withMessage("La contraseña actual es obligatoria."),
    isPassword("new_password", "La nueva contraseña"),
    body("new_password").custom((val, { req }) => {
      if (val === req.body.current_password)
        throw new Error("La nueva contraseña no puede ser igual a la actual.");
      return true;
    }),
  ],
  updateMe: [
    isString("full_name", "El nombre completo", {
      min: 3,
      max: 150,
      required: false,
    }),
    isEmail(false),
    body("phone")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ min: 6, max: 30 })
      .withMessage("El teléfono debe tener entre 6 y 30 caracteres.")
      .matches(/^[0-9+()\s-]+$/)
      .withMessage("El teléfono tiene un formato inválido."),
    body("address")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage("La dirección no puede superar los 255 caracteres."),
  ],
  id: [isUUIDParam("id", "El ID de usuario")],
};

// ── CUSTOMERS ─────────────────────────────────────────────────
const customers = {
  create: [
    isString("full_name", "El nombre completo", { min: 3, max: 150 }),
    isDni("dni"),
    isPhone(false),
    isEmail(false),
    body("address")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage("La dirección no puede superar los 255 caracteres."),
    isUUID("assigned_collector_id", "El cobrador asignado", false),
  ],
  update: [
    isUUIDParam("id", "El ID de cliente"),
    isString("full_name", "El nombre completo", {
      min: 3,
      max: 150,
      required: false,
    }),
    isPhone(false),
    isEmail(false),
    body("address")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 255 })
      .withMessage("La dirección no puede superar los 255 caracteres."),
    isUUID("assigned_collector_id", "El cobrador asignado", false),
  ],
  id: [isUUIDParam("id", "El ID de cliente")],
};

// ── PRODUCTS ──────────────────────────────────────────────────
const products = {
  create: [
    isString("title", "El título del producto", { min: 2, max: 150 }),
    isString("description", "La descripción del producto", {
      min: 1,
      max: 500,
      required: false,
    }),
    isString("model", "El modelo", { min: 1, max: 100, required: false }),
    isUUID("brand_id", "El ID de marca", false),
    isUUID("category_id", "El ID de categoría", false),
  ],
  update: [
    isUUIDParam("id", "El ID de producto"),
    isString("title", "El título del producto", {
      min: 2,
      max: 150,
      required: false,
    }),
    isString("description", "La descripción del producto", {
      min: 1,
      max: 500,
      required: false,
    }),
    isString("model", "El modelo", { min: 1, max: 100, required: false }),
    isUUID("brand_id", "El ID de marca", false),
    isUUID("category_id", "El ID de categoría", false),
  ],
  id: [isUUIDParam("id", "El ID de producto")],
};

// ── CREDITS ───────────────────────────────────────────────────
const credits = {
  create: [
    isUUID("customer_id", "El cliente"),
    isEnum("type", "El tipo de crédito", ["SALE", "LOAN"]),
    // LOAN requiere total_amount; para SALE se calcula de los productos
    body("total_amount")
      .if(body("type").equals("LOAN"))
      .notEmpty()
      .withMessage("El monto total es obligatorio para préstamos.")
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 1 || n > 99999999)
          throw new Error(
            "El monto total debe ser un número entre 1 y 99999999.",
          );
        return true;
      }),
    body("installments_count")
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser un número entre 1 y 120."),
    isEnum("payment_frequency", "La frecuencia de pago", [
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
    ]),
    body("unit_ids")
      .if(body("type").equals("SALE"))
      .isArray({ min: 1 })
      .withMessage("Las ventas deben incluir al menos una unidad de producto."),
    body("unit_ids.*")
      .optional()
      .isUUID()
      .withMessage("Cada unit_id debe ser un UUID válido."),
    // Enganche (solo aplica a SALE)
    body("down_payment")
      .optional({ nullable: true })
      .custom((val) => {
        if (val == null) return true;
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error("El enganche debe ser un número mayor o igual a 0.");
        return true;
      }),
    body("down_payment_cash")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error(
            "El enganche en efectivo debe ser un número mayor o igual a 0.",
          );
        return true;
      }),
    body("down_payment_transfer")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error(
            "El enganche por transferencia debe ser un número mayor o igual a 0.",
          );
        return true;
      }),
    body("down_payment_method")
      .if(
        (val, { req }) =>
          parseFloat(req.body.down_payment) >= 0.01 &&
          req.body.down_payment_cash == null &&
          req.body.down_payment_transfer == null,
      )
      .isIn(["CASH", "TRANSFER"])
      .withMessage("El método de pago del enganche debe ser CASH o TRANSFER."),
    body("down_payment_transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage(
        "La referencia del enganche no puede superar los 100 caracteres.",
      ),
    body("prepaid_installments")
      .optional({ nullable: true })
      .isInt({ min: 1, max: 120 })
      .withMessage(
        "La cantidad de cuotas adelantadas debe ser un entero entre 1 y 120.",
      ),
    body("prepaid_installments_cash")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error(
            "El adelanto en efectivo debe ser un número mayor o igual a 0.",
          );
        return true;
      }),
    body("prepaid_installments_transfer")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error(
            "El adelanto por transferencia debe ser un número mayor o igual a 0.",
          );
        return true;
      }),
    body("prepaid_installments_method")
      .if(
        (val, { req }) =>
          parseInt(req.body.prepaid_installments, 10) >= 1 &&
          req.body.prepaid_installments_cash == null &&
          req.body.prepaid_installments_transfer == null,
      )
      .isIn(["CASH", "TRANSFER"])
      .withMessage("El método de pago del adelanto debe ser CASH o TRANSFER."),
    body("prepaid_installments_transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage(
        "La referencia del adelanto no puede superar los 100 caracteres.",
      ),
    body("notes")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las notas no pueden superar los 500 caracteres."),
    body().custom((b) => {
      const has = (v) =>
        v !== undefined && v !== null && String(v).trim() !== "";
      const downCash = parseFloat(b.down_payment_cash || 0);
      const downTransfer = parseFloat(b.down_payment_transfer || 0);
      const downSplitTotal = downCash + downTransfer;
      if (
        (has(b.down_payment_cash) || has(b.down_payment_transfer)) &&
        has(b.down_payment) &&
        Math.round(downSplitTotal * 100) !==
          Math.round(parseFloat(b.down_payment) * 100)
      )
        throw new Error(
          "El desglose del enganche debe coincidir con el enganche total.",
        );

      const prepaidCash = parseFloat(b.prepaid_installments_cash || 0);
      const prepaidTransfer = parseFloat(b.prepaid_installments_transfer || 0);
      if (
        prepaidCash + prepaidTransfer > 0 &&
        !(parseInt(b.prepaid_installments, 10) >= 1)
      )
        throw new Error(
          "Para declarar cuotas adelantadas debés indicar la cantidad de cuotas.",
        );
      if (
        parseInt(b.prepaid_installments, 10) >= 1 &&
        !has(b.prepaid_installments_method) &&
        !(prepaidCash + prepaidTransfer > 0)
      )
        throw new Error("El método de pago del adelanto es obligatorio.");
      return true;
    }),
  ],
  simulate: [
    isEnum("type", "El tipo de crédito", ["SALE", "LOAN"]),
    // LOAN: total_amount obligatorio. SALE: productos obligatorios (tasa es por producto)
    body("total_amount")
      .optional()
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 1 || n > 99999999)
          throw new Error(
            "El monto total debe ser un número entre 1 y 99999999.",
          );
        return true;
      }),
    body("products")
      .optional()
      .isArray({ min: 1 })
      .withMessage("Los productos deben ser un arreglo con al menos un ítem."),
    body("products.*.variant_id")
      .optional()
      .isUUID()
      .withMessage("Cada variant_id debe ser un UUID válido."),
    body("products.*.quantity")
      .optional()
      .isInt({ min: 1, max: 9999 })
      .withMessage("La cantidad debe ser entre 1 y 9999."),
    body("products.*.installments_count")
      .optional()
      .isInt({ min: 1, max: 120 })
      .withMessage(
        "La cantidad de cuotas por producto debe ser entre 1 y 120.",
      ),
    body("down_payment")
      .optional({ nullable: true })
      .custom((val) => {
        if (val == null) return true;
        const n = parseFloat(val);
        if (isNaN(n) || n < 0)
          throw new Error("El enganche debe ser un número mayor o igual a 0.");
        return true;
      }),
    isDate("first_payment_date", "La fecha del primer pago", false),
    body().custom((body) => {
      if (body.type === "LOAN" && !body.total_amount)
        throw new Error("El monto total es obligatorio para préstamos.");
      if (body.type === "SALE" && (!body.products || !body.products.length))
        throw new Error(
          "Para ventas se deben indicar las variantes con cantidad (products[{variant_id, quantity}]).",
        );
      return true;
    }),
    body("installments_count")
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser un número entre 1 y 120."),
    isEnum("payment_frequency", "La frecuencia de pago", [
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
    ]),
  ],
  simulateAll: [
    isEnum("type", "El tipo de crédito", ["SALE", "LOAN"]),
    body("total_amount")
      .optional()
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 1 || n > 99999999)
          throw new Error(
            "El monto total debe ser un número entre 1 y 99999999.",
          );
        return true;
      }),
    body("products")
      .optional()
      .isArray({ min: 1 })
      .withMessage("Los productos deben ser un arreglo con al menos un ítem."),
    body("products.*.variant_id")
      .optional()
      .isUUID()
      .withMessage("Cada variant_id debe ser un UUID válido."),
    body("products.*.quantity")
      .optional()
      .isInt({ min: 1, max: 9999 })
      .withMessage("La cantidad debe ser entre 1 y 9999."),
    body().custom((body) => {
      if (body.type === "LOAN" && !body.total_amount)
        throw new Error("El monto total es obligatorio para préstamos.");
      if (body.type === "SALE" && (!body.products || !body.products.length))
        throw new Error(
          "Para ventas se deben indicar las variantes (products[{variant_id, quantity}]).",
        );
      return true;
    }),
  ],
  approve: [
    isUUIDParam("id", "El ID de crédito"),
    body("installments_count")
      .optional()
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser entre 1 y 120."),
  ],
  reject: [
    isUUIDParam("id", "El ID de crédito"),
    body("rejection_reason")
      .trim()
      .notEmpty()
      .withMessage("El motivo de rechazo es obligatorio.")
      .isLength({ min: 5, max: 500 })
      .withMessage("El motivo debe tener entre 5 y 500 caracteres."),
  ],
  earlySettlement: [
    isUUIDParam("id", "El ID de crédito"),
    body("amount_cash")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 99999999)
          throw new Error(
            "El monto en efectivo debe ser un número entre 0 y 99999999.",
          );
        return true;
      }),
    body("amount_transfer")
      .optional({ nullable: true })
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0 || n > 99999999)
          throw new Error(
            "El monto en transferencia debe ser un número entre 0 y 99999999.",
          );
        return true;
      }),
    body("payment_method")
      .optional()
      .isIn(["CASH", "TRANSFER"])
      .withMessage("El método de pago debe ser CASH o TRANSFER."),
    body("transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("La referencia no puede superar los 100 caracteres."),
    body().custom((b) => {
      const has = (v) =>
        v !== undefined && v !== null && String(v).trim() !== "";
      const mixedShape = has(b.amount_cash) || has(b.amount_transfer);
      if (mixedShape) {
        const transfer = parseFloat(b.amount_transfer) || 0;
        const total = (parseFloat(b.amount_cash) || 0) + transfer;
        if (!(total > 0))
          throw new Error(
            "La suma de efectivo y transferencia debe ser mayor a 0.",
          );
      } else if (!has(b.payment_method)) {
        throw new Error("El método de pago es obligatorio.");
      }
      return true;
    }),
  ],
  refinance: [
    isUUIDParam("id", "El ID de crédito"),
    body("installments_count")
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser un entero entre 1 y 120."),
    isEnum("payment_frequency", "La frecuencia de pago", [
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
    ]),
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("El motivo de refinanciación es obligatorio.")
      .isLength({ min: 5, max: 500 })
      .withMessage("El motivo debe tener entre 5 y 500 caracteres."),
    body("extra_charges")
      .optional({ nullable: true })
      .isFloat({ min: 0 })
      .withMessage("Los cargos adicionales deben ser un número positivo."),
    body("notes")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las notas no pueden superar los 500 caracteres."),
  ],
  planChange: [
    isUUIDParam("id", "El ID de crédito"),
    body("reason")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("El motivo no puede superar los 500 caracteres."),
  ],
  writeOff: [
    isUUIDParam("id", "El ID de crédito"),
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("El motivo del castigo es obligatorio.")
      .isLength({ min: 5, max: 500 })
      .withMessage("El motivo debe tener entre 5 y 500 caracteres."),
    body("observations")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las observaciones no pueden superar los 500 caracteres."),
  ],
  id: [isUUIDParam("id", "El ID de crédito")],
};

// ── PAYMENTS (pre-cargas de cobro) ────────────────────────────

// Validación de los montos de un cobro. Acepta dos formatos mutuamente
// excluyentes (el servicio los normaliza a { amount_received, amount_cash,
// amount_transfer }):
//   · Mixto:  amount_cash y/o amount_transfer (efectivo + transferencia).
//   · Legacy: amount_received + payment_method (un solo medio).
const MONTO_MAX = 99999999;
const isMoneyField = (val, label) => {
  const n = parseFloat(val);
  if (isNaN(n) || n < 0 || n > MONTO_MAX)
    throw new Error(`${label} debe ser un número entre 0 y ${MONTO_MAX}.`);
  return true;
};
const paymentAmountFields = [
  body("amount_cash")
    .optional({ nullable: true })
    .custom((val) => isMoneyField(val, "El monto en efectivo")),
  body("amount_transfer")
    .optional({ nullable: true })
    .custom((val) => isMoneyField(val, "El monto en transferencia")),
  body("amount_received")
    .optional({ nullable: true })
    .custom((val) => isMoneyField(val, "El monto recibido")),
  body("payment_method")
    .optional()
    .isIn(["CASH", "TRANSFER"])
    .withMessage("El método de pago debe ser CASH o TRANSFER."),
  body("transfer_reference")
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 100 })
    .withMessage(
      "La referencia de transferencia no puede superar los 100 caracteres.",
    ),
  // Coherencia entre los campos de monto: exactamente un formato y total > 0.
  body().custom((b) => {
    const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
    const mixedShape = has(b.amount_cash) || has(b.amount_transfer);
    const legacyShape = has(b.amount_received);

    if (mixedShape && legacyShape)
      throw new Error(
        "Enviá los montos por medio (amount_cash/amount_transfer) o el formato simple (amount_received + payment_method), no ambos.",
      );
    if (!mixedShape && !legacyShape)
      throw new Error("Debe indicar el monto del cobro.");

    if (mixedShape) {
      const transfer = parseFloat(b.amount_transfer) || 0;
      const total = (parseFloat(b.amount_cash) || 0) + transfer;
      if (!(total > 0))
        throw new Error(
          "La suma de efectivo y transferencia debe ser mayor a 0.",
        );
    } else {
      if (!has(b.payment_method))
        throw new Error("El método de pago es obligatorio.");
      if (!(parseFloat(b.amount_received) > 0))
        throw new Error("El monto recibido debe ser mayor a 0.");
    }
    return true;
  }),
];

const payments = {
  create: [
    isUUID("installment_id", "La cuota"),
    ...paymentAmountFields,
    body("notes")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las observaciones no pueden superar los 500 caracteres."),
    isDate("next_visit_date", "La fecha de próxima visita", false),
  ],
  reject: [
    isUUIDParam("id", "El ID de cobro"),
    body("rejection_reason")
      .trim()
      .notEmpty()
      .withMessage("El motivo de rechazo es obligatorio.")
      .isLength({ min: 5, max: 500 })
      .withMessage("El motivo debe tener entre 5 y 500 caracteres."),
  ],
  adminDirect: [
    isUUID("installment_id", "La cuota"),
    ...paymentAmountFields,
    body("notes")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las observaciones no pueden superar los 500 caracteres."),
  ],
  reverse: [
    isUUIDParam("id", "El ID de cobro"),
    body("reason")
      .trim()
      .notEmpty()
      .withMessage("El motivo de reversión es obligatorio.")
      .isLength({ min: 5, max: 500 })
      .withMessage("El motivo debe tener entre 5 y 500 caracteres."),
  ],
  id: [isUUIDParam("id", "El ID de cobro")],
};

// ── INTEREST RATES ────────────────────────────────────────────
const interestRates = {
  create: [
    body("installments_count")
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser entre 1 y 120."),
    isEnum("payment_frequency", "La frecuencia de pago", [
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
    ]),
    body("min_amount").custom((val) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0)
        throw new Error(
          "El monto mínimo debe ser un número mayor o igual a 0.",
        );
      return true;
    }),
    body("max_amount")
      .optional({ nullable: true })
      .custom((val, { req }) => {
        if (val == null) return true;
        const n = parseFloat(val);
        if (isNaN(n) || n < 1)
          throw new Error("El monto máximo debe ser un número mayor a 0.");
        if (n <= parseFloat(req.body.min_amount))
          throw new Error("El monto máximo debe ser mayor al monto mínimo.");
        return true;
      }),
    body("rate").custom((val) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0.001 || n > 100)
        throw new Error(
          "El coeficiente debe ser un número positivo (ej: 0.6 = 60%, 1.2 = 120%).",
        );
      return true;
    }),
  ],
  update: [
    isUUIDParam("id", "El ID de tasa"),
    body("rate")
      .optional()
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0.001 || n > 100)
          throw new Error(
            "El coeficiente debe ser un número positivo (ej: 0.6 = 60%, 1.2 = 120%).",
          );
        return true;
      }),
    isBool("active", "El estado", false),
  ],
  id: [isUUIDParam("id", "El ID de tasa")],
};

// ── CASH REGISTER ─────────────────────────────────────────────
const cashRegister = {
  close: [
    body("declared_cash").custom((val) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0)
        throw new Error(
          "El efectivo declarado debe ser un número mayor o igual a 0.",
        );
      return true;
    }),
    body("observations")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las observaciones no pueden superar los 500 caracteres."),
  ],
};

// ── PENALTIES (mora) ──────────────────────────────────────────
const penalties = {
  apply: [
    isUUIDParam("id", "El ID de cuota"),
    body("penalty_amount").custom((val) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0.01)
        throw new Error("El monto de mora debe ser mayor a 0.");
      return true;
    }),
  ],
  earlyPay: [
    isUUIDParam("id", "El ID de cuota"),
    body("amount_cash")
      .optional({ nullable: true })
      .custom((val) => isMoneyField(val, "El monto en efectivo")),
    body("amount_transfer")
      .optional({ nullable: true })
      .custom((val) => isMoneyField(val, "El monto en transferencia")),
    body("payment_method")
      .optional()
      .isIn(["CASH", "TRANSFER"])
      .withMessage("El método de pago debe ser CASH o TRANSFER."),
    body("transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("La referencia no puede superar los 100 caracteres."),
    body().custom((b) => {
      const has = (v) =>
        v !== undefined && v !== null && String(v).trim() !== "";
      const mixedShape = has(b.amount_cash) || has(b.amount_transfer);
      if (mixedShape) {
        const transfer = parseFloat(b.amount_transfer) || 0;
        const total = (parseFloat(b.amount_cash) || 0) + transfer;
        if (!(total > 0))
          throw new Error(
            "La suma de efectivo y transferencia debe ser mayor a 0.",
          );
      } else if (!has(b.payment_method)) {
        throw new Error("El método de pago es obligatorio.");
      }
      return true;
    }),
  ],
  id: [isUUIDParam("id", "El ID de cuota")],
};

// ── COLLECTIONS (planillas de cobro) ─────────────────────────
const collections = {
  generate: [
    isUUID("collector_id", "El cobrador"),
    isDate("date", "La fecha de cobro"),
    isEnum(
      "filter",
      "El filtro de cuotas",
      ["TODAY", "OVERDUE", "TODAY_AND_OVERDUE", "ALL_PENDING"],
      false,
    ),
    isBool("skip_if_exists", "La opción de no regenerar si ya existe", false),
  ],
  id: [isUUIDParam("id", "El ID de planilla")],
};

// ── PRODUCT VARIANTS ─────────────────────────────────────────
const productVariants = {
  create: [
    isUUID("product_id", "El ID de producto"),
    isString("color", "El color", { min: 1, max: 50, required: false }),
    isString("size", "El talle", { min: 1, max: 50, required: false }),
    isString("capacity", "La capacidad", { min: 1, max: 50, required: false }),
    isPositiveNumber("current_price", "El precio", {
      min: 0.01,
      max: 99999999,
    }),
    body("initial_units")
      .optional({ nullable: true })
      .isInt({ min: 0, max: 10000 })
      .withMessage("initial_units debe ser un entero entre 0 y 10000."),
    body().custom((_, { req }) => {
      const { color, size, capacity } = req.body;
      if (!color && !size && !capacity)
        throw new Error(
          "La variante debe tener al menos un atributo: color, talle o capacidad.",
        );
      return true;
    }),
  ],
  bulkCreate: [
    isUUID("product_id", "El ID de producto"),
    body("rows")
      .isArray({ min: 1, max: 100 })
      .withMessage("Debés enviar entre 1 y 100 filas."),
    body("rows.*.color")
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("El color debe tener entre 1 y 50 caracteres."),
    body("rows.*.size")
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("El talle debe tener entre 1 y 50 caracteres."),
    body("rows.*.capacity")
      .optional({ nullable: true })
      .isString()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("La capacidad debe tener entre 1 y 50 caracteres."),
    body("rows.*.current_price")
      .optional({ nullable: true })
      .custom((val) => {
        if (val === "" || val === null || val === undefined) return true;
        const num = Number(val);
        if (Number.isNaN(num) || num < 0.01 || num > 99999999) {
          throw new Error("El precio debe ser mayor a 0 y menor a 99.999.999.");
        }
        return true;
      }),
    body("rows.*.initial_units")
      .optional({ nullable: true })
      .isInt({ min: 0, max: 10000 })
      .withMessage("initial_units debe ser un entero entre 0 y 10000."),
  ],
  update: [
    isUUIDParam("id", "El ID de variante"),
    isString("color", "El color", { min: 1, max: 50, required: false }),
    isString("size", "El talle", { min: 1, max: 50, required: false }),
    isString("capacity", "La capacidad", { min: 1, max: 50, required: false }),
    isPositiveNumber("current_price", "El precio", {
      min: 0.01,
      max: 99999999,
      required: false,
    }),
    body().custom((_, { req }) => {
      const { color, size, capacity, current_price } = req.body;
      if (
        color === undefined &&
        size === undefined &&
        capacity === undefined &&
        current_price === undefined
      )
        throw new Error(
          "Debe enviar al menos un campo para actualizar: color, talle, capacidad o precio.",
        );
      return true;
    }),
  ],
  id: [isUUIDParam("id", "El ID de variante")],
};

// ── PRODUCT RATES ────────────────────────────────────────────
const productRates = {
  create: [
    isUUID("product_id", "El producto"),
    isEnum("payment_frequency", "La frecuencia de pago", [
      "WEEKLY",
      "BIWEEKLY",
      "MONTHLY",
    ]),
    body("installments_count")
      .isInt({ min: 1, max: 120 })
      .withMessage("La cantidad de cuotas debe ser entre 1 y 120."),
    body("rate").custom((val) => {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0.001 || n > 100)
        throw new Error(
          "El coeficiente debe ser un número positivo (ej: 0.32 = 32%, 1.2 = 120%).",
        );
      return true;
    }),
  ],
  update: [
    isUUIDParam("id", "El ID de tasa"),
    body("rate")
      .optional()
      .custom((val) => {
        const n = parseFloat(val);
        if (isNaN(n) || n < 0.001 || n > 100)
          throw new Error(
            "El coeficiente debe ser un número positivo (ej: 0.32 = 32%, 1.2 = 120%).",
          );
        return true;
      }),
    isBool("active", "El estado", false),
  ],
  id: [isUUIDParam("id", "El ID de tasa")],
};

// ── EXPENSES (gastos) ─────────────────────────────────────────
const expenses = {
  create: [
    isPositiveNumber("amount", "El monto", { min: 0.01, max: 99999999 }),
    isString("description", "La descripción", { min: 2, max: 500 }),
    isDate("expense_date", "La fecha del gasto"),
    isEnum("payment_method", "El método de pago", ["CASH", "TRANSFER"]),
    isUUID("category_id", "El ID de categoría", true),
    isEnum("source", "El origen del gasto", ["DAILY", "COMPANY"], false),
    body("transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("La referencia no puede superar los 100 caracteres."),
  ],
  update: [
    isUUIDParam("id", "El ID de gasto"),
    isPositiveNumber("amount", "El monto", { min: 0.01, max: 99999999 }),
    isString("description", "La descripción", { min: 2, max: 500 }),
    isDate("expense_date", "La fecha del gasto"),
    isEnum("payment_method", "El método de pago", ["CASH", "TRANSFER"]),
    isUUID("category_id", "El ID de categoría", true),
    body("transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("La referencia no puede superar los 100 caracteres."),
  ],
  id: [isUUIDParam("id", "El ID de gasto")],
};

// ── EXPENSE CATEGORIES ────────────────────────────────────────
const expenseCategories = {
  create: [isString("name", "El nombre de la categoría", { min: 2, max: 100 })],
  id: [isUUIDParam("id", "El ID de categoría")],
};

// ── PRODUCT CATEGORIES ────────────────────────────────────────
const productCategories = {
  create: [isString("name", "El nombre de la categoría", { min: 2, max: 100 })],
  id: [isUUIDParam("id", "El ID de categoría")],
};

// ── NOTIFICATIONS ─────────────────────────────────────────────
const NOTIFICATION_TYPE_VALUES = [
  "MORA",
  "INSTALLMENT_DUE",
  "APPROVAL_REQUEST",
  "CASH_REGISTER",
  "NEW_CUSTOMER",
];
const notifications = {
  updatePreference: [
    param("type")
      .isIn(NOTIFICATION_TYPE_VALUES)
      .withMessage(
        `El tipo debe ser uno de: ${NOTIFICATION_TYPE_VALUES.join(", ")}.`,
      ),
    body("enabled")
      .optional()
      .isBoolean()
      .withMessage("enabled debe ser booleano."),
    body("frequency")
      .optional()
      .isIn(["INSTANT", "DAILY", "WEEKLY"])
      .withMessage("frequency debe ser INSTANT, DAILY o WEEKLY."),
  ],
  id: [isUUIDParam("id", "El ID de notificación")],
};

// ── COMMISSIONS ───────────────────────────────────────────────
const commissions = {
  liquidate: [
    isUUID("user_id", "El usuario a liquidar"),
    isEnum("payment_method", "El método de pago", ["CASH", "TRANSFER"]),
    body("transfer_reference")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage("La referencia no puede superar los 100 caracteres."),
  ],
};

// ── COLLECTION ATTEMPTS (intentos de cobranza) ───────────────
const collectionAttempts = {
  create: [
    isUUID("installment_id", "La cuota"),
    isEnum("attempt_type", "El tipo de intento", ["NO_PAYMENT", "NOT_FOUND"]),
    body("reason")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("El motivo no puede superar los 500 caracteres."),
    isDate("next_visit_date", "La fecha de próxima visita", false),
    body("notes")
      .optional({ nullable: true, checkFalsy: true })
      .trim()
      .isLength({ max: 500 })
      .withMessage("Las observaciones no pueden superar los 500 caracteres."),
  ],
  id: [isUUIDParam("id", "El ID de intento de cobranza")],
};

// ── HOLIDAYS (feriados) ───────────────────────────────────────
const holidays = {
  create: [
    isDate("date", "La fecha del feriado"),
    isString("name", "El nombre del feriado", { min: 2, max: 150 }),
    isEnum("type", "El tipo de feriado", [
      "EXTRAORDINARY",
      "NATIONAL",
      "LOCAL",
      "BANKING",
    ]),
    isBool("affects_due_dates", "Afecta vencimientos", false),
    isBool("active", "Estado activo", false),
    isBool("repeats_annually", "Se repite anualmente", false),
    isBool("recalculateFutureInstallments", "Recalcular cuotas futuras", false),
  ],
  update: [
    isUUIDParam("id", "El ID de feriado"),
    isString("name", "El nombre del feriado", {
      min: 2,
      max: 150,
      required: false,
    }),
    isEnum(
      "type",
      "El tipo de feriado",
      ["EXTRAORDINARY", "NATIONAL", "LOCAL", "BANKING"],
      false,
    ),
    isBool("affects_due_dates", "Afecta vencimientos", false),
    isBool("active", "Estado activo", false),
    isBool("repeats_annually", "Se repite anualmente", false),
  ],
  id: [isUUIDParam("id", "El ID de feriado")],
  duplicateYear: [
    body("sourceYear")
      .isInt({ min: 2000, max: 2999 })
      .withMessage("El año origen debe ser un número entero entre 2000 y 2999.")
      .toInt(),
  ],
};

const test = {
  forceInstallmentDueDate: [
    isUUIDParam("id", "El ID de la cuota"),
    isDate("due_date", "La fecha de vencimiento"),
  ],
  resetCommissionLiquidations: [isUUIDParam("userId", "El ID del usuario")],
  forceCreditCreatedAt: [
    isUUIDParam("id", "El ID del crédito"),
    body("created_at")
      .isISO8601()
      .withMessage("created_at debe ser una fecha ISO8601 válida."),
  ],
  forceTokensExpired: [isUUIDParam("userId", "El ID del usuario")],
};

module.exports = {
  // Bloques atómicos reutilizables
  isString,
  isDni,
  isEmail,
  isPhone,
  isUUID,
  isUUIDParam,
  isEnum,
  isPositiveNumber,
  isPositiveInt,
  isPassword,
  isDate,
  isBool,
  paginationRules,
  // Validadores completos por módulo
  users,
  customers,
  products,
  productVariants,
  credits,
  payments,
  interestRates,
  productRates,
  cashRegister,
  penalties,
  collections,
  collectionAttempts,
  commissions,
  holidays,
  expenses,
  expenseCategories,
  productCategories,
  notifications,
  test,
};

// productUnits se valida directamente en su propio router.
