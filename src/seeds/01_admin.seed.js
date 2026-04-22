// Semilla 01 — Usuario Admin inicial
const bcrypt = require('bcryptjs');
const pool   = require('../config/db');

const seed = async () => {
  console.log('  Creando usuario Admin...');

  const tempPassword = 'Admin1234';
  const hash = await bcrypt.hash(tempPassword, 10);

  const existing = await pool.query(`SELECT id FROM users WHERE dni = '00000000'`);

  if (existing.rows.length > 0) {
    console.log('   ⚠️   Admin ya existe — actualizando contraseña y desbloqueando...');
    await pool.query(
      `UPDATE users
       SET password_hash    = $1,
           is_temp_password = TRUE,
           failed_attempts  = 0,
           locked_at        = NULL,
           force_relogin_at = NULL,
           updated_at       = NOW()
       WHERE dni = '00000000'`,
      [hash]
    );
  } else {
    await pool.query(
      `INSERT INTO users (full_name, dni, email, password_hash, role, status, is_temp_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['Administrador del Sistema', '00000000', 'admin@sistema.com', hash, 'ADMIN', 'ACTIVE', true]
    );
  }

  console.log('   ✅  Admin listo.');
  console.log('');
  console.log('   ┌─────────────────────────────────┐');
  console.log('   │  Credenciales iniciales          │');
  console.log('   │  DNI:        00000000            │');
  console.log(`   │  Contraseña: ${tempPassword}          │`);
  console.log('   │  ⚠️  Cambiarla en el primer login │');
  console.log('   └─────────────────────────────────┘');
};

module.exports = seed;
