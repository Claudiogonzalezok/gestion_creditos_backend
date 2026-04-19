require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const app = express();

// ── Seguridad y CORS ──────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:4200').split(','),
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

// ── Parsers ───────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Logger ────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok:      true,
    message: 'API funcionando correctamente.',
    version: '1.0.0',
    env:     process.env.NODE_ENV,
  });
});

// ── Rutas ─────────────────────────────────────────────────────
app.use('/api/auth',         require('./modules/auth/auth.routes'));
app.use('/api/users',        require('./modules/users/users.routes'));
app.use('/api/customers',    require('./modules/customers/customers.routes'));
app.use('/api/products',     require('./modules/products/products.routes'));
app.use('/api/system-config',require('./modules/systemConfig/systemConfig.routes'));
app.use('/api/interest-rates',require('./modules/interestRates/interestRates.routes'));
app.use('/api/product-rates', require('./modules/productRates/productRates.routes'));
app.use('/api/credits',      require('./modules/credits/credits.routes'));
app.use('/api/installments', require('./modules/installments/installments.routes'));
app.use('/api/payments',     require('./modules/payments/payments.routes'));
app.use('/api/collections',  require('./modules/collections/collections.routes'));
app.use('/api/commissions',  require('./modules/commissions/commissions.routes'));
app.use('/api/cash-register',require('./modules/cashRegister/cashRegister.routes'));
app.use('/api/reports',      require('./modules/reports/reports.routes'));
app.use('/api/portal',       require('./modules/portal/portal.routes'));

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// ── Error handler global ──────────────────────────────────────
app.use((err, req, res, next) => {
  // JSON mal formado enviado por el cliente
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: 'El cuerpo de la petición no es un JSON válido.' });
  }
  // Errores de negocio lanzados con { status, message }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ ok: false, message: err.message });
  }
  console.error('🔴  Error no controlado:', err);
  res.status(500).json({ ok: false, message: 'Error interno del servidor.' });
});

// ── Iniciar servidor ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀  Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📋  Ambiente: ${process.env.NODE_ENV || 'development'}`);

  // Iniciar cron jobs solo fuera del entorno de tests
  if (process.env.NODE_ENV !== 'test') {
    require('./jobs/overdueInstallments.job').start();
    require('./jobs/creditExpiry.job').start();
    require('./jobs/weeklyCommissionCycle.job').start();
    require('./jobs/tokenCleanup.job').start();
  }
});

module.exports = app;
