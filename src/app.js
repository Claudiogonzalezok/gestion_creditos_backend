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
app.use('/api/auth',  require('./modules/auth/auth.routes'));
app.use('/api/users', require('./modules/users/users.routes'));
app.use('/api/customers', require('./modules/customers/customers.routes'));
app.use('/api/products',  require('./modules/products/products.routes'));

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, message: `Ruta no encontrada: ${req.method} ${req.originalUrl}` });
});

// ── Error handler global ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('🔴  Error no controlado:', err);
  res.status(500).json({ ok: false, message: 'Error interno del servidor.' });
});

// ── Iniciar servidor ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀  Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📋  Ambiente: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
