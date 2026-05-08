const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Generar token para usuarios internos (Admin, Vendedor, Cobrador)
const generateInternalToken = (user, expiresIn = process.env.JWT_EXPIRY_INTERNAL || '8h') => {
  return jwt.sign(
    {
      sub:  user.id,
      role: user.role,
      aud:  'sistema-interno',
    },
    process.env.JWT_SECRET_INTERNAL,
    {
      expiresIn,
      jwtid: uuidv4(),
    }
  );
};

// Generar token para clientes del portal público
const generatePortalToken = (customer, expiresIn = process.env.JWT_EXPIRY_PORTAL || '30m') => {
  return jwt.sign(
    {
      sub:  customer.id,
      role: 'CLIENT',
      aud:  'portal-cliente',
    },
    process.env.JWT_SECRET_PORTAL,
    {
      expiresIn,
      jwtid: uuidv4(),
    }
  );
};

// Verificar token interno
const verifyInternalToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET_INTERNAL, {
    audience: 'sistema-interno',
  });
};

// Verificar token del portal
const verifyPortalToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET_PORTAL, {
    audience: 'portal-cliente',
  });
};

// Extraer token del header Authorization: Bearer <token>
const extractToken = (req) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1];
};

// Genera un refresh token opaco: UUID v4 raw para la cookie + su hash SHA-256 para BD.
// El raw nunca se almacena — solo el hash. Así un dump de BD no compromete los tokens.
const generateRefreshToken = () => {
  const raw    = uuidv4();
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hashed };
};

// Hashea el raw refresh token recibido de la cookie para buscarlo en BD.
const hashRefreshToken = (raw) => {
  return crypto.createHash('sha256').update(raw).digest('hex');
};

module.exports = {
  generateInternalToken,
  generatePortalToken,
  verifyInternalToken,
  verifyPortalToken,
  extractToken,
  generateRefreshToken,
  hashRefreshToken,
};
