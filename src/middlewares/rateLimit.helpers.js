/**
 * Traduce TRUST_PROXY al valor de `app.set('trust proxy', ...)` de Express.
 * "true"/"false" → booleano, un entero ("1") → cantidad de saltos de proxy,
 * cualquier otro texto ("loopback", "10.0.0.0/8, uniquelocal") → lista de
 * subredes confiables. Sin variable: "loopback" (nginx en el mismo host).
 * @param {string|undefined} value - process.env.TRUST_PROXY
 * @returns {boolean|number|string}
 */
const parseTrustProxy = (value) => {
  const raw = String(value ?? 'loopback').trim();
  if (raw === '' ) return 'loopback';
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
};

/**
 * Arma el mensaje 429 de un rate limiter con el tiempo restante real de la
 * ventana (en vez de un "15 minutos" fijo).
 * @param {string} prefix - texto inicial, p. ej. "Demasiados intentos de acceso."
 * @returns {Function} message handler (req, res) para express-rate-limit
 */
const rateLimitMessage = (prefix) => (req) => {
  const resetTime = req.rateLimit && req.rateLimit.resetTime;
  const ms = resetTime ? new Date(resetTime).getTime() - Date.now() : 0;
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return {
    ok: false,
    message: `${prefix} Intentá nuevamente en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
  };
};

module.exports = { parseTrustProxy, rateLimitMessage };
