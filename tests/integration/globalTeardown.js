// Global teardown ejecutado UNA SOLA VEZ después de toda la suite.
// Cierra el pool global que la app usa (src/config/db.js) si quedó abierto,
// para que jest pueda terminar limpiamente sin warnings de handles abiertos.

module.exports = async () => {
  try {
    // Solo intentamos cerrarlo si fue cargado en algún momento.
    const pool = require('../../src/config/db');
    if (pool && typeof pool.end === 'function') {
      await pool.end();
    }
  } catch (err) {
    // Si ya estaba cerrado o nunca se cargó, ignoramos.
  }
};
