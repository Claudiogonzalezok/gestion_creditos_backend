// Guarda común de las semillas: los seeds cargan usuarios con contraseñas
// conocidas y datos de demo, por lo que nunca deben correr en producción.

/**
 * Lanza un error si el entorno es de producción.
 * @param {Object} env - variables de entorno a validar (default: process.env)
 */
const assertSeedAllowed = (env = process.env) => {
  if (env.NODE_ENV === 'production') {
    throw new Error('Semillas abortadas: NODE_ENV=production. Los seeds son solo para desarrollo y test.');
  }
};

module.exports = { assertSeedAllowed };
