const crypto = require('crypto');

// Caracteres sin ambigüedades visuales (sin 0/O, 1/I/l)
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/**
 * Genera una contraseña temporal de 8 caracteres usando crypto.randomBytes()
 * para garantizar aleatoriedad criptográficamente segura.
 */
const generateTempPassword = () => {
  const bytes = crypto.randomBytes(8);
  let pass = '';
  for (let i = 0; i < 8; i++) {
    pass += CHARS[bytes[i] % CHARS.length];
  }
  return pass;
};

module.exports = { generateTempPassword };
