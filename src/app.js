require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const {
  parseTrustProxy,
  rateLimitMessage,
} = require("./middlewares/rateLimit.helpers");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");
const {
  validateSecureConfig,
  isDocsEnabled,
  areTestRoutesEnabled,
} = require("./config/secureConfig");

// Falla el arranque en producción con flags inseguros o sin credenciales de BD.
validateSecureConfig();

const app = express();

// ── Proxy inverso ─────────────────────────────────────────────
// Detrás de Nginx la IP real del cliente llega en X-Forwarded-For; sin esto el
// rate limit cuenta a todos como uno solo (#35). Default loopback: nginx en el
// mismo host. Formatos de TRUST_PROXY en rateLimit.helpers.parseTrustProxy.
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:4200")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/**
 * Interpreta flags booleanos de entorno con tolerancia a formatos comunes.
 * @param {string | undefined} value Valor crudo de variable de entorno.
 * @returns {boolean} True cuando el valor representa un booleano afirmativo.
 */
const envFlag = (value) => {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

// ── Documentación API ─────────────────────────────────────────
// Solo fuera de producción (#34). CSP permisiva solo para esta ruta
// (swagger-ui necesita inline scripts/styles).
if (isDocsEnabled()) {
  app.use(
    "/api/docs",
    (req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:;",
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: "API Gestión Créditos",
      swaggerOptions: { persistAuthorization: true },
    }),
  );
}

// ── Seguridad y CORS ──────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

// ── Parsers ───────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Logger ────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// ── Health check ──────────────────────────────────────────────
// Verifica la base (SELECT 1 con timeout): 503 si no responde.
app.use("/api/health", require("./modules/health/health.routes"));

// ── Rate limiting — endpoints de login ───────────────────────
const disableLoginRateLimit = envFlag(process.env.DISABLE_LOGIN_RATE_LIMIT);

if (!disableLoginRateLimit) {
  const loginLimiter = rateLimit({
    windowMs: parseInt(
      process.env.LOGIN_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000),
      10,
    ),
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || "20", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: rateLimitMessage("Demasiados intentos de acceso."),
  });
  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth/portal/login", loginLimiter);
} else {
  console.warn(
    "⚠️  Rate limit de login deshabilitado por DISABLE_LOGIN_RATE_LIMIT=true",
  );
}

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage("Demasiadas solicitudes de renovación de sesión."),
});
app.use("/api/auth/refresh", refreshLimiter);
app.use("/api/auth/portal/refresh", refreshLimiter);

// Recuperación de contraseña (#88): límite propio y estricto por IP. No se
// apaga con DISABLE_LOGIN_RATE_LIMIT (no hay flujo E2E que lo necesite).
const passwordResetLimiter = rateLimit({
  windowMs: parseInt(
    process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000),
    10,
  ),
  max: parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || "5", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage("Demasiadas solicitudes de recuperación de contraseña."),
});
app.use("/api/auth/forgot-password", passwordResetLimiter);
app.use("/api/auth/reset-password", passwordResetLimiter);

// ── Rutas ─────────────────────────────────────────────────────
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/users", require("./modules/users/users.routes"));
app.use("/api/customers", require("./modules/customers/customers.routes"));
app.use("/api/products", require("./modules/products/products.routes"));
app.use(
  "/api/product-brands",
  require("./modules/productBrands/productBrands.routes"),
);
app.use(
  "/api/product-variants",
  require("./modules/productVariants/productVariants.routes"),
);
app.use(
  "/api/product-units",
  require("./modules/productUnits/productUnits.routes"),
);
app.use(
  "/api/system-config",
  require("./modules/systemConfig/systemConfig.routes"),
);
app.use("/api/company", require("./modules/company/company.routes"));
app.use("/api/holidays", require("./modules/holidays/holidays.routes"));
app.use(
  "/api/interest-rates",
  require("./modules/interestRates/interestRates.routes"),
);
app.use(
  "/api/product-rates",
  require("./modules/productRates/productRates.routes"),
);
app.use("/api/credits", require("./modules/credits/credits.routes"));
app.use(
  "/api/installments",
  require("./modules/installments/installments.routes"),
);
app.use("/api/payments", require("./modules/payments/payments.routes"));
app.use(
  "/api/collection-attempts",
  require("./modules/collectionAttempts/collectionAttempts.routes"),
);
app.use(
  "/api/collections",
  require("./modules/collections/collections.routes"),
);
app.use(
  "/api/commissions",
  require("./modules/commissions/commissions.routes"),
);
app.use(
  "/api/cash-register",
  require("./modules/cashRegister/cashRegister.routes"),
);
app.use(
  "/api/cash-sessions",
  require("./modules/cashSessions/cashSessions.routes"),
);
app.use(
  "/api/cash-accounts",
  require("./modules/cashAccounts/cashAccounts.routes"),
);
app.use(
  "/api/business-days",
  require("./modules/businessDays/businessDays.routes"),
);
app.use("/api/expenses", require("./modules/expenses/expenses.routes"));
app.use(
  "/api/expense-categories",
  require("./modules/expenseCategories/expenseCategories.routes"),
);
app.use(
  "/api/product-categories",
  require("./modules/productCategories/productCategories.routes"),
);
app.use(
  "/api/notifications",
  require("./modules/notifications/notifications.routes"),
);
app.use("/api/reports", require("./modules/reports/reports.routes"));
app.use("/api/portal", require("./modules/portal/portal.routes"));
app.use("/api/admin/cron-logs", require("./modules/cronLogs/cronLogs.routes"));

// ── Rutas de testing (solo E2E, ver guarda en test.routes.js) ──
// Nunca en producción: validateSecureConfig ya aborta el arranque si el flag está.
if (areTestRoutesEnabled()) {
  app.use("/api/test", require("./modules/test/test.routes"));
}

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res
    .status(404)
    .json({
      ok: false,
      message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    });
});

// ── Error handler global ──────────────────────────────────────
app.use((err, req, res, _next) => {
  // JSON mal formado enviado por el cliente
  if (err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({
        ok: false,
        message: "El cuerpo de la petición no es un JSON válido.",
      });
  }
  // Errores de negocio lanzados con { status, message, code? }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      ok: false,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }
  console.error("🔴  Error no controlado:", err);
  res.status(500).json({ ok: false, message: "Error interno del servidor." });
});

// Arranque + cron + cierre ordenado (SIGTERM/SIGINT, errores no manejados).
if (require.main === module) {
  require("./utils/lifecycle").startServer(app);
}

module.exports = app;
