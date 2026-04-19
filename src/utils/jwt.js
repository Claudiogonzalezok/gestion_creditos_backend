const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// Generar token para usuarios internos (Admin, Vendedor, Cobrador)
const generateInternalToken = (user, expiresIn = process.env.JWT_EXPIRY_INTERNAL || '8h') => {
  return jwt.sign(
    {
      sub:  user.id,
      dni:  user.dni,
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
      dni:  customer.dni,
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

module.exports = {
  generateInternalToken,
  generatePortalToken,
  verifyInternalToken,
  verifyPortalToken,
  extractToken,
};
