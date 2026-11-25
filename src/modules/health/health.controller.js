const service = require('./health.service');

/**
 * Health check para PM2/monitores: 200 si la API y la base responden,
 * 503 si la base no responde (no reinicia el proceso, solo informa).
 */
const check = async (req, res) => {
  const timeoutMs = parseInt(process.env.HEALTH_DB_TIMEOUT_MS || '2000', 10);
  const dbUp = await service.isDatabaseUp(timeoutMs);
  if (!dbUp) {
    return res.status(503).json({
      ok: false,
      message: 'Base de datos no disponible.',
      db: 'down',
    });
  }
  return res.json({
    ok: true,
    message: 'API funcionando correctamente.',
    version: '1.0.0',
    // Sin `env`: no se expone información del entorno (issue #34).
    db: 'up',
  });
};

module.exports = { check };
