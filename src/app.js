require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

const app = express();

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
// CSP permisiva solo para esta ruta (swagger-ui necesita inline scripts/styles)
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
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "API funcionando correctamente.",
    version: "1.0.0",
    env: process.env.NODE_ENV,
  });
});

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
    message: {
      ok: false,
      message:
        "Demasiados intentos de acceso. Intentá nuevamente en 15 minutos.",
    },
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
  message: {
    ok: false,
    message:
      "Demasiadas solicitudes de renovación de sesión. Intentá nuevamente en 15 minutos.",
  },
});
app.use("/api/auth/refresh", refreshLimiter);
app.use("/api/auth/portal/refresh", refreshLimiter);

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
app.use(
  "/api/notifications",
  require("./modules/notifications/notifications.routes"),
);
app.use("/api/admin/cron-logs", require("./modules/cronLogs/cronLogs.routes"));

// ── Rutas de testing (solo E2E, ver guarda en test.routes.js) ──
if (process.env.ENABLE_TEST_ROUTES === "true") {
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
app.use((err, req, res, next) => {
  // JSON mal formado enviado por el cliente
  if (err.type === "entity.parse.failed") {
    return res
      .status(400)
      .json({
        ok: false,
        message: "El cuerpo de la petición no es un JSON válido.",
      });
  }
  // Errores de negocio lanzados con { status, message }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ ok: false, message: err.message });
  }
  console.error("🔴  Error no controlado:", err);
  res.status(500).json({ ok: false, message: "Error interno del servidor." });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀  Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📋  Ambiente: ${process.env.NODE_ENV || "development"}`);

    // Iniciar cron jobs solo fuera del entorno de tests
    if (process.env.NODE_ENV !== "test") {
      require("./jobs/overdueInstallments.job").start();
      require("./jobs/creditExpiry.job").start();
      require("./jobs/weeklyCommissionCycle.job").start();
      require("./jobs/tokenCleanup.job").start();
      require("./jobs/installmentDueSoon.job").start();
      require("./jobs/cashRegisterReminder.job").start();
    }
  });
}

module.exports = app;
