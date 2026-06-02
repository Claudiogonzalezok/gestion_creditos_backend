const store = new Map();

const TTL = {
  SHORT: 5 * 60 * 1000,
  LONG: 30 * 60 * 1000,
};

/**
 * Obtiene un valor del caché.
 * Devuelve `undefined` si la clave no existe o expiró (miss).
 * Devuelve el valor almacenado en cualquier otro caso, incluyendo `null`.
 * @param {string} key
 * @returns {*}
 */
const get = (key) => {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
};

/**
 * Guarda un valor en el caché.
 * @param {string} key
 * @param {*}      value
 * @param {number} [ttlMs=TTL.SHORT] - Tiempo de vida en milisegundos.
 */
const set = (key, value, ttlMs = TTL.SHORT) => {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
};

/**
 * Elimina una clave específica del caché.
 * @param {string} key
 */
const invalidate = (key) => store.delete(key);

/**
 * Elimina todas las claves que comiencen con el prefijo dado.
 * @param {string} prefix
 */
const invalidateByPrefix = (prefix) => {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
};

/**
 * Limpia todo el caché. Solo para uso en tests.
 */
const clearAll = () => store.clear();

module.exports = { get, set, invalidate, invalidateByPrefix, clearAll, TTL };
