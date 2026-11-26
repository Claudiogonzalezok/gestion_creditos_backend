/**
 * Notificador saliente (email) enchufable.
 *
 * El repo no tiene dependencia de envío de correo (no hay nodemailer), así que
 * el envío real se delega a un transporte registrado con `setTransport()`.
 * Transportes incluidos:
 *   · `log`      → no envía nada: guarda el mensaje en memoria (`outbox`) y,
 *                  fuera de test, lo imprime por consola. Solo desarrollo/test.
 *   · `disabled` → falla cerrado con 503 NOTIFIER_NOT_CONFIGURED.
 *
 * Selección por `NOTIFIER_TRANSPORT` (log | disabled). Sin variable: `log`
 * fuera de producción, `disabled` en producción. En producción `log` se
 * ignora (escribiría tokens de recuperación en los logs) y queda `disabled`
 * hasta que se registre un transporte real.
 */

const outbox = [];
let customTransport = null;

const notConfiguredError = () => ({
  status: 503,
  code: 'NOTIFIER_NOT_CONFIGURED',
  message: 'El envío de notificaciones no está configurado en el servidor. Contactá al administrador.',
});

const logTransport = {
  name: 'log',
  /**
   * @param {{to: string, subject: string, text: string}} message
   */
  send: async (message) => {
    outbox.push({ ...message, sent_at: new Date() });
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`📧  [notifier:log] to=${message.to} subject="${message.subject}"\n${message.text}`);
    }
  },
};

/**
 * Nombre del transporte efectivo según entorno.
 * @returns {string} 'custom' | 'log' | 'disabled'
 */
const transportName = () => {
  if (customTransport) return 'custom';
  const isProd = process.env.NODE_ENV === 'production';
  const raw = String(process.env.NOTIFIER_TRANSPORT || '').trim().toLowerCase();
  if (raw === 'disabled') return 'disabled';
  if (isProd) return 'disabled';
  return 'log';
};

/**
 * Indica si hay un transporte capaz de entregar mensajes.
 * @returns {boolean}
 */
const isConfigured = () => transportName() !== 'disabled';

/**
 * Envía un mensaje. Lanza 503 NOTIFIER_NOT_CONFIGURED si no hay transporte.
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{transport: string}>}
 */
const send = async (message) => {
  const name = transportName();
  if (name === 'disabled') throw notConfiguredError();
  const transport = name === 'custom' ? customTransport : logTransport;
  await transport.send(message);
  return { transport: name };
};

/**
 * Registra un transporte real ({ send: async (message) => void }) o lo quita
 * con null. Pensado para enchufar SMTP/API de correo sin tocar los servicios.
 * @param {{send: Function}|null} transport
 */
const setTransport = (transport) => {
  customTransport = transport;
};

/** Vacía el outbox del transporte `log` (tests). */
const clearOutbox = () => {
  outbox.length = 0;
};

module.exports = { send, isConfigured, transportName, setTransport, outbox, clearOutbox, notConfiguredError };
