// Semilla 04 — Datos bulk para pruebas E2E y auditorías de UI
// Crea: 3 usuarios operativos, 5 categorías, 20 productos+unidades+tasas,
//       30 clientes, 40 créditos con cuotas y pagos, 3 cierres de caja.
//
// Requisito: ejecutar semillas 01, 02 y 03 antes que esta.
//
// Contraseña de todos los usuarios: 1234
// Ejecutar: npm run seed (o node src/seeds/index.seed.js)

const bcrypt = require('bcryptjs');
const pool   = require('../config/db');

// ── Fecha de referencia fija = 2026-04-28 ──────────────────────────────────
const TODAY = new Date('2026-04-28T12:00:00Z');

const dateStr = (d) => {
  const dd = new Date(d);
  return dd.toISOString().split('T')[0];
};
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};
const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};
// Fórmula del negocio: ceil al millar superior
const cuota = (total, rate, count) =>
  Math.ceil((total * (1 + rate)) / count / 1000) * 1000;

// ──────────────────────────────────────────────────────────────────────────
const seed = async () => {
  // Idempotencia: si el vendedor ya existe, saltar
  const check = await pool.query(`SELECT id FROM users WHERE dni = '11111111'`);
  if (check.rows.length > 0) {
    console.log('   ⚠️   Semilla 04 ya ejecutada — saltando.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Admin ID (requiere semilla 01) ───────────────────────────────────
    const adminRow = await client.query(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`
    );
    if (!adminRow.rows[0]) throw new Error('Admin no encontrado. Ejecutar semilla 01 primero.');
    const adminId = adminRow.rows[0].id;

    // ── 1. Usuarios operativos ───────────────────────────────────────────
    console.log('  Creando usuarios operativos...');
    const hash = await bcrypt.hash('1234', 10);

    const sellerRow = await client.query(
      `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
       VALUES ($1,$2,$3,$4,$5,'SELLER','ACTIVE',FALSE) RETURNING id`,
      ['Carlos Mendoza', '11111111', 'vendedor@sistema.com',
       'Av. Corrientes 1234, CABA', hash]
    );
    const sellerId = sellerRow.rows[0].id;

    const collectorRow = await client.query(
      `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
       VALUES ($1,$2,$3,$4,$5,'COLLECTOR','ACTIVE',FALSE) RETURNING id`,
      ['María González', '22222222', 'cobrador@sistema.com',
       'Av. Santa Fe 567, CABA', hash]
    );
    const collectorId = collectorRow.rows[0].id;

    const hybridRow = await client.query(
      `INSERT INTO users (full_name, dni, email, address, password_hash, role, status, is_temp_password)
       VALUES ($1,$2,$3,$4,$5,'SELLER_COLLECTOR','ACTIVE',FALSE) RETURNING id`,
      ['Juan Rodríguez', '33333333', 'mixto@sistema.com',
       'Calle Florida 890, CABA', hash]
    );
    const hybridId = hybridRow.rows[0].id;
    console.log('   ✅  3 usuarios creados.');

    // ── 2. Categorías de productos ───────────────────────────────────────
    console.log('  Creando categorías y productos...');
    const catNames = [
      'Electrónica', 'Electrodomésticos', 'Indumentaria y Calzado',
      'Muebles y Hogar', 'Telefonía',
    ];
    const catIds = {};
    for (const name of catNames) {
      const r = await client.query(
        `INSERT INTO product_categories (name) VALUES ($1)
         ON CONFLICT DO NOTHING RETURNING id`,
        [name]
      );
      if (r.rows[0]) {
        catIds[name] = r.rows[0].id;
      } else {
        const r2 = await client.query(
          `SELECT id FROM product_categories WHERE LOWER(name)=LOWER($1)`, [name]
        );
        catIds[name] = r2.rows[0].id;
      }
    }

    // ── 3. Lookup de marcas + alta de marcas adicionales ────────────────
    const brandRows = await client.query(
      `SELECT id, name FROM product_brands WHERE active = TRUE`
    );
    const brandMap = {};
    for (const row of brandRows.rows) brandMap[row.name] = row.id;

    // Marcas no incluidas en el preload de la migración base
    for (const name of ['Noblex', 'Longvie']) {
      if (!brandMap[name]) {
        const r = await client.query(
          `INSERT INTO product_brands (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [name]
        );
        brandMap[name] = r.rows[0].id;
      }
    }

    // ── 4. Productos + variantes + unidades + tasas ──────────────────────
    // title    → debe coincidir exactamente con los productDesc usados en los créditos
    // soldUnits → unidades en estado SOLD para vincular a créditos ya aprobados
    const productsData = [
      // ── Electrónica ───────────────────────────────────────────────────
      {
        title:       'Smart TV 43" Samsung 4K',
        description: 'Smart TV 43 pulgadas resolución 4K UHD, sistema Tizen, Wi-Fi y Bluetooth integrados.',
        model:       'UN43TU7000GCXZB',
        brand:       'Samsung', cat: 'Electrónica',
        color: null, size: null, capacity: '43 pulgadas',
        price: 450000, availableUnits: 5, soldUnits: 5,
      },
      {
        title:       'Smart TV 55" LG OLED',
        description: 'Televisor OLED 55 pulgadas 4K con panel α9 Gen5 AI, webOS 22 y control ThinQ AI.',
        model:       'OLED55C2PSA',
        brand:       'LG', cat: 'Electrónica',
        color: null, size: null, capacity: '55 pulgadas',
        price: 890000, availableUnits: 2, soldUnits: 2,
      },
      {
        title:       'Notebook Lenovo IdeaPad 15"',
        description: 'Notebook 15.6" Full HD, Intel Core i5 de 11ª gen, 8 GB RAM DDR4, 512 GB SSD, Windows 11 Home.',
        model:       'IdeaPad 3 15ITL6',
        brand:       'Lenovo', cat: 'Electrónica',
        color: null, size: null, capacity: '15" · 8 GB · 512 GB',
        price: 680000, availableUnits: 3, soldUnits: 4,
      },
      {
        title:       'Tablet Samsung Galaxy Tab A8',
        description: 'Tablet 10.5" con procesador Unisoc T618, 3 GB RAM, 32 GB almacenamiento, Wi-Fi, Android 11.',
        model:       'SM-X200NZAALAR',
        brand:       'Samsung', cat: 'Electrónica',
        color: null, size: null, capacity: '10.5" · 32 GB',
        price: 280000, availableUnits: 0, soldUnits: 0,
      },
      {
        title:       'Televisor 32" Noblex HD',
        description: 'Televisor LED 32 pulgadas HD 720p, entradas HDMI y USB. Ideal para ambientes secundarios.',
        model:       'EA32X5100',
        brand:       'Noblex', cat: 'Electrónica',
        color: null, size: null, capacity: '32 pulgadas',
        price: 190000, availableUnits: 5, soldUnits: 3,
      },
      // ── Electrodomésticos ─────────────────────────────────────────────
      {
        title:       'Aire Acondicionado Split 3000w Noblex',
        description: 'Split frío/calor 3000 W con control remoto, temporizador 24 h y filtro lavable.',
        model:       'NXSA30WICO',
        brand:       'Noblex', cat: 'Electrodomésticos',
        color: 'Blanco', size: null, capacity: '3000 W',
        price: 520000, availableUnits: 5, soldUnits: 3,
      },
      {
        title:       'Heladera Whirlpool No Frost 400L',
        description: 'Heladera con freezer No Frost 400 litros, dispensador de agua, display electrónico y sistema Total No Frost.',
        model:       'WRB42AB2',
        brand:       'Whirlpool', cat: 'Electrodomésticos',
        color: 'Acero inoxidable', size: null, capacity: '400 litros',
        price: 750000, availableUnits: 2, soldUnits: 3,
      },
      {
        title:       'Lavarropas Automático Drean 7kg',
        description: 'Lavarropas carga frontal 7 kg, 14 programas, centrifugado 1000 RPM y función Eco.',
        model:       'Next 7.14 ECO',
        brand:       'Drean', cat: 'Electrodomésticos',
        color: 'Blanco', size: null, capacity: '7 kg',
        price: 490000, availableUnits: 2, soldUnits: 2,
      },
      {
        title:       'Microondas Whirlpool 25L',
        description: 'Microondas 25 litros con grill, 5 niveles de potencia y función descongelado automático por peso.',
        model:       'WM25BD',
        brand:       'Whirlpool', cat: 'Electrodomésticos',
        color: 'Negro', size: null, capacity: '25 litros',
        price: 180000, availableUnits: 8, soldUnits: 4,
      },
      {
        title:       'Cocina Longvie 4 hornallas',
        description: 'Cocina a gas 4 hornallas con horno y grill, encendido automático, termostato y visor en puerta.',
        model:       'M6200F',
        brand:       'Longvie', cat: 'Electrodomésticos',
        color: 'Acero inoxidable', size: null, capacity: null,
        price: 320000, availableUnits: 0, soldUnits: 6,
      },
      // ── Telefonía ─────────────────────────────────────────────────────
      {
        title:       'Celular Motorola Edge 30',
        description: 'Smartphone 6.5" OLED 144 Hz, Snapdragon 778G+, 8 GB RAM, 256 GB, cámara triple 50 MP.',
        model:       'XT2203-1',
        brand:       'Motorola', cat: 'Telefonía',
        color: 'Negro', size: null, capacity: '256 GB',
        price: 350000, availableUnits: 9, soldUnits: 8,
      },
      {
        title:       'Celular Samsung Galaxy A54',
        description: 'Smartphone 6.4" Super AMOLED, Exynos 1380, 8 GB RAM, 128 GB, cámara triple 50 MP, IP67.',
        model:       'SM-A546EZKDARO',
        brand:       'Samsung', cat: 'Telefonía',
        color: 'Negro', size: null, capacity: '128 GB',
        price: 420000, availableUnits: 4, soldUnits: 5,
      },
      {
        title:       'iPhone 14 128GB',
        description: 'Smartphone Apple chip A15 Bionic, pantalla Super Retina XDR 6.1", cámara dual 12 MP, Face ID.',
        model:       'A2882',
        brand:       'Apple', cat: 'Telefonía',
        color: 'Medianoche', size: null, capacity: '128 GB',
        price: 1200000, availableUnits: 1, soldUnits: 1,
      },
      {
        title:       'Celular Xiaomi Redmi Note 12',
        description: 'Smartphone 6.67" AMOLED 120 Hz, Snapdragon 685, 4 GB RAM, 128 GB, cámara triple 50 MP.',
        model:       'Redmi Note 12 4G',
        brand:       'Xiaomi', cat: 'Telefonía',
        color: 'Negro', size: null, capacity: '128 GB',
        price: 250000, availableUnits: 10, soldUnits: 6,
      },
      // ── Indumentaria y Calzado ────────────────────────────────────────
      {
        title:       'Zapatillas Nike Air Max 270',
        description: 'Zapatillas con cámara Air Max 270 en el talón, parte superior de malla transpirable y suela de goma.',
        model:       'Air Max 270',
        brand:       'Nike', cat: 'Indumentaria y Calzado',
        color: 'Negro / Rojo', size: '42', capacity: null,
        price: 180000, availableUnits: 12, soldUnits: 12,
      },
      {
        title:       'Zapatillas Adidas Ultraboost',
        description: 'Zapatillas running con entresuela Boost de amortiguación, parte superior Primeknit y suela Continental.',
        model:       'Ultraboost 22',
        brand:       'Adidas', cat: 'Indumentaria y Calzado',
        color: 'Blanco', size: '42', capacity: null,
        price: 220000, availableUnits: 7, soldUnits: 8,
      },
      {
        title:       'Campera Puma Deportiva',
        description: 'Campera deportiva con cierre completo, bolsillos laterales con cierre y logo Puma bordado. Tela liviana.',
        model:       'ESS Padded Jacket',
        brand:       'Puma', cat: 'Indumentaria y Calzado',
        color: 'Negro', size: 'L', capacity: null,
        price: 95000, availableUnits: 0, soldUnits: 3,
      },
      // ── Muebles y Hogar ───────────────────────────────────────────────
      {
        title:       'Sofá 3 cuerpos Rústico',
        description: 'Sofá 3 cuerpos tapizado en tela premium, estructura de madera maciza y patas de acero cromado.',
        model:       'SOF-3C-RUST',
        brand:       'Genérico', cat: 'Muebles y Hogar',
        color: 'Gris', size: null, capacity: null,
        price: 380000, availableUnits: 2, soldUnits: 1,
      },
      {
        title:       'Juego de dormitorio + colchón Queen',
        description: 'Cama Queen 160×200 cm con dos mesas de luz y colchón de resortes ensacados 160×200 cm.',
        model:       'DOR-QUEEN-SET',
        brand:       'Genérico', cat: 'Muebles y Hogar',
        color: 'Blanco', size: 'Queen 160×200', capacity: null,
        price: 620000, availableUnits: 1, soldUnits: 1,
      },
      {
        title:       'Mesa comedor 6 sillas',
        description: 'Juego de comedor mesa rectangular 160×90 cm con tapa de vidrio templado y 6 sillas en ecocuero.',
        model:       'MES-COM-6S',
        brand:       'Genérico', cat: 'Muebles y Hogar',
        color: 'Natural / Negro', size: null, capacity: null,
        price: 290000, availableUnits: 3, soldUnits: 2,
      },
    ];

    // Tasas por producto (mismo coeficiente para todos): 1c, 2c, 3c, 4c mensual
    const productRatesTemplate = [
      { freq: 'MONTHLY', count: 1, rate: 0.25 },
      { freq: 'MONTHLY', count: 2, rate: 0.48 },
      { freq: 'MONTHLY', count: 3, rate: 0.80 },
      { freq: 'MONTHLY', count: 4, rate: 0.96 },
    ];

    // productMap[desc] = { id, price, soldUnitIds: [...] }
    const productMap = {};
    let skuCounter = 10000;

    for (const pd of productsData) {
      const pRes = await client.query(
        `INSERT INTO products (title, description, model, brand_id, category_id, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING id`,
        [pd.title, pd.description || null, pd.model || null,
         pd.brand ? (brandMap[pd.brand] || null) : null, catIds[pd.cat]]
      );
      const productId = pRes.rows[0].id;

      // Variante por defecto con atributos y precio
      const vRes = await client.query(
        `INSERT INTO product_variants (product_id, color, size, capacity, current_price, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING id`,
        [productId, pd.color || null, pd.size || null, pd.capacity || null, pd.price]
      );
      const variantId = vRes.rows[0].id;

      const soldUnitIds = [];

      // Unidades SOLD (las que ya se asignaron a créditos)
for (let i = 0; i < pd.soldUnits; i++) {
        const uRes = await client.query(
          `INSERT INTO product_units (variant_id, unit_code, status)
           VALUES ($1, $2, 'SOLD') RETURNING id`,
          [variantId, `U${skuCounter++}`]
        );
        soldUnitIds.push(uRes.rows[0].id);
      }
      // Unidades AVAILABLE (stock actual)
for (let i = 0; i < pd.availableUnits; i++) {
        await client.query(
          `INSERT INTO product_units (variant_id, unit_code, status)
           VALUES ($1, $2, 'AVAILABLE')`,
          [variantId, `U${skuCounter++}`]
        );
      }
      // Tasas del producto
      for (const pr of productRatesTemplate) {
        await client.query(
          `INSERT INTO product_rates (product_id, payment_frequency, installments_count, rate, active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [productId, pr.freq, pr.count, pr.rate]
        );
      }

      productMap[pd.title] = { id: productId, price: pd.price, soldUnitIds };
    }
    console.log('   ✅  5 categorías, 20 productos, unidades y tasas creados.');

    // ── 4. Clientes ──────────────────────────────────────────────────────
    console.log('  Creando 30 clientes...');

    // indices 0-19: ACTIVE normales
    // indices 20-24: INACTIVE
    // indices 25-29: ACTIVE morosos (tendrán créditos con cuotas OVERDUE)
    const customersData = [
      { name: 'Luciana Beatriz Ramírez',   dni: '32541876', phone: '1154321890', email: 'luciana.ramirez@gmail.com',    address: 'Av. Rivadavia 2340 Piso 3, CABA',         collector: collectorId, status: 'ACTIVE'   },
      { name: 'Diego Alejandro Fernández', dni: '28976543', phone: '1167890234', email: 'dfernandez@hotmail.com',        address: 'Corrientes 876 Dto 5B, Rosario',          collector: collectorId, status: 'ACTIVE'   },
      { name: 'María Eugenia Soto',        dni: '35120654', phone: '1143219876', email: 'mary.soto@gmail.com',           address: 'San Martín 1234, Córdoba',               collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Pablo Nicolás Gutierrez',   dni: '30876512', phone: '1155678901', email: 'pablo.gut@yahoo.com.ar',        address: 'Belgrano 456, Mendoza',                  collector: collectorId, status: 'ACTIVE'   },
      { name: 'Valeria Roxana Torres',     dni: '33412987', phone: '1162345678', email: 'valeria.torres@gmail.com',      address: 'Av. de Mayo 890, CABA',                  collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Ezequiel Martín López',     dni: '29543210', phone: '1170123456', email: 'ezelopez@gmail.com',            address: 'Tucumán 345 Piso 2, CABA',               collector: collectorId, status: 'ACTIVE'   },
      { name: 'Carolina Andrea Méndez',    dni: '36789012', phone: '1148765432', email: 'caro.mendez@gmail.com',         address: 'Lavalle 2100, Buenos Aires',             collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Rodrigo Alberto Vargas',    dni: '31654789', phone: '1159876543', email: 'rodrigo.vargas@outlook.com',    address: 'Salta 678, Tucumán',                     collector: collectorId, status: 'ACTIVE'   },
      { name: 'Florencia Noelia Castro',   dni: '34210876', phone: '1175432109', email: 'flor.castro@gmail.com',         address: 'Junín 123, La Plata',                    collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Nicolás Damián Herrera',    dni: '27890123', phone: '1142109876', email: 'nicoh@gmail.com',               address: 'Av. Callao 543, CABA',                   collector: collectorId, status: 'ACTIVE'   },
      { name: 'Sabrina Paola Morales',     dni: '38012345', phone: '1153456789', email: 'sabri.morales@hotmail.com',     address: 'Maipú 987, Córdoba',                     collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Sebastián Eduardo Romero',  dni: '32109876', phone: '1168901234', email: 'seba.romero@gmail.com',         address: 'Cerrito 210, CABA',                      collector: collectorId, status: 'ACTIVE'   },
      { name: 'Adriana Vanesa Pérez',      dni: '29765432', phone: '1145678012', email: 'adriana.perez@yahoo.com',       address: 'España 456, Mendoza',                    collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Gustavo Horacio Díaz',      dni: '31234567', phone: '1172345678', email: 'gdiaz@gmail.com',               address: 'Av. Pueyrredón 789, CABA',               collector: collectorId, status: 'ACTIVE'   },
      { name: 'Natalia Silvina Campos',    dni: '35678901', phone: '1149012345', email: 'nati.campos@gmail.com',         address: 'Urquiza 321, Rosario',                   collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Tomás Ignacio Blanco',      dni: '28345678', phone: '1160123456', email: 'tomas.blanco@gmail.com',        address: 'Rivadavia 567, Córdoba',                 collector: collectorId, status: 'ACTIVE'   },
      { name: 'Jimena Lucía Vega',         dni: '37012345', phone: '1177654321', email: 'jimena.vega@hotmail.com',       address: 'San Juan 890, CABA',                     collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Fernando Darío Ruiz',       dni: '30123456', phone: '1154321987', email: 'fernando.ruiz@gmail.com',       address: 'Mitre 234, Mar del Plata',               collector: collectorId, status: 'ACTIVE'   },
      { name: 'Claudia Marcela Silva',     dni: '33567890', phone: '1161234567', email: 'claudia.silva@gmail.com',       address: 'Belgrano 123, CABA',                     collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Ariel Ignacio Molina',      dni: '26789012', phone: '1148901234', email: 'ariel.molina@outlook.com',      address: 'Chacabuco 456, La Plata',                collector: collectorId, status: 'ACTIVE'   },
      // INACTIVE
      { name: 'Roberto Carlos Giménez',    dni: '24567890', phone: '1135678901', email: 'roberto.gim@gmail.com',         address: 'Av. Las Heras 789, CABA',                collector: null,        status: 'INACTIVE' },
      { name: 'Marcela Inés Suárez',       dni: '27345678', phone: '1142345678', email: 'marcela.suarez@yahoo.com.ar',   address: 'Sarmiento 234, Rosario',                 collector: null,        status: 'INACTIVE' },
      { name: 'Hugo Alfredo Navarro',      dni: '22123456', phone: '1129012345', email: null,                            address: 'Independencia 567, Córdoba',             collector: null,        status: 'INACTIVE' },
      { name: 'Silvia Raquel Ortega',      dni: '25901234', phone: '1136789012', email: 'silviaortega@gmail.com',        address: null,                                     collector: null,        status: 'INACTIVE' },
      { name: 'Ernesto Fabián Palacios',   dni: '23678901', phone: '1133456789', email: null,                            address: 'Av. Independencia 890, CABA',            collector: null,        status: 'INACTIVE' },
      // Morosos (indices 25-29)
      { name: 'Osvaldo Rubén Medina',      dni: '26012345', phone: '1137890123', email: 'osvaldo.medina@gmail.com',      address: 'Las Flores 123, Lomas de Zamora',        collector: collectorId, status: 'ACTIVE'   },
      { name: 'Patricia Noemí Acosta',     dni: '34890123', phone: '1155012345', email: 'patricia.acosta@hotmail.com',   address: 'Av. San Martín 456, Quilmes',            collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Marcelo Andrés Fuentes',    dni: '31890234', phone: '1162890123', email: 'marcelo.fuentes@gmail.com',     address: 'Pueyrredón 789, Lanús',                  collector: collectorId, status: 'ACTIVE'   },
      { name: 'Viviana Cecilia Ríos',      dni: '29234567', phone: '1146012345', email: 'viviana.rios@gmail.com',        address: 'Rivadavia 012, Morón',                   collector: hybridId,    status: 'ACTIVE'   },
      { name: 'Alejandro José Ibáñez',     dni: '27678901', phone: '1134678901', email: 'alex.ibanez@yahoo.com.ar',      address: 'Corrientes 345, San Isidro',             collector: collectorId, status: 'ACTIVE'   },
    ];

    const customerIds = [];
    for (const cd of customersData) {
      const r = await client.query(
        `INSERT INTO customers (full_name, dni, address, phone, email, assigned_collector_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [cd.name, cd.dni, cd.address || null, cd.phone, cd.email || null, cd.collector, cd.status]
      );
      customerIds.push(r.rows[0].id);
    }
    console.log('   ✅  30 clientes creados.');

    // ── 5–6. Créditos + cuotas + pagos ──────────────────────────────────
    console.log('  Creando 40 créditos, cuotas y pagos...');

    /**
     * Inserta crédito SALE aprobado, cuotas e payments para cuotas PAID.
     * @param {object} opts
     * @param {string} opts.customerId
     * @param {string} opts.createdBy   - sellerId | hybridId
     * @param {string} opts.approvedAt  - ISO date string "YYYY-MM-DD"
     * @param {string} opts.productDesc
     * @param {number} opts.installmentsCount
     * @param {number} opts.rate
     * @param {'ACTIVE'|'SETTLED'|'OVERDUE'} opts.creditBehavior
     *   ACTIVE  → cuotas pasadas PAID, futuras PENDING
     *   SETTLED → todas las cuotas PAID, crédito SETTLED
     *   OVERDUE → cuotas pasadas OVERDUE (sin pago), futuras PENDING
     */
    const createSaleCredit = async ({
      customerId, createdBy, approvedAt, productDesc,
      installmentsCount, rate, creditBehavior,
    }) => {
      const product  = productMap[productDesc];
      const total    = product.price;
      const unitId   = product.soldUnitIds.shift();
      if (!unitId) throw new Error(`Sin unidades SOLD para: ${productDesc}`);

      const amt        = cuota(total, rate, installmentsCount);
      const approved   = new Date(approvedAt);
      const finalStatus = creditBehavior === 'SETTLED' ? 'SETTLED' : 'ACTIVE';

      const cRes = await client.query(
        `INSERT INTO credits
           (customer_id, created_by, type, total_amount, down_payment, installments_count,
            payment_frequency, interest_rate, status, approved_by, approved_at,
            created_at, updated_at)
         VALUES ($1,$2,'SALE',$3,0,$4,'MONTHLY',$5,$6,$7,$8,$8,$8)
         RETURNING id`,
        [customerId, createdBy, total, installmentsCount, rate, finalStatus, adminId, approved]
      );
      const creditId = cRes.rows[0].id;

      await client.query(
        `INSERT INTO credit_products (credit_id, product_unit_id, historical_price, historical_rate)
         VALUES ($1,$2,$3,$4)`,
        [creditId, unitId, total, rate]
      );

      await _insertInstallmentsAndPayments(
        client, creditId, installmentsCount, amt, approved, creditBehavior, collectorId, adminId
      );

      if (creditBehavior === 'SETTLED') {
        const settledAt = addMonths(approved, installmentsCount);
        await client.query(
          `UPDATE credits
           SET status='SETTLED', settled_at=$1, settlement_type='NORMAL', updated_at=$1
           WHERE id=$2`,
          [settledAt, creditId]
        );
      }
      return creditId;
    };

    /**
     * Inserta crédito LOAN aprobado, cuotas e payments para cuotas PAID.
     */
    const createLoanCredit = async ({
      customerId, createdBy, approvedAt, totalAmount,
      installmentsCount, rate, creditBehavior,
    }) => {
      const amt        = cuota(totalAmount, rate, installmentsCount);
      const approved   = new Date(approvedAt);
      const finalStatus = creditBehavior === 'SETTLED' ? 'SETTLED' : 'ACTIVE';

      const cRes = await client.query(
        `INSERT INTO credits
           (customer_id, created_by, type, total_amount, down_payment, installments_count,
            payment_frequency, interest_rate, status, approved_by, approved_at,
            created_at, updated_at)
         VALUES ($1,$2,'LOAN',$3,0,$4,'MONTHLY',$5,$6,$7,$8,$8,$8)
         RETURNING id`,
        [customerId, createdBy, totalAmount, installmentsCount, rate, finalStatus, adminId, approved]
      );
      const creditId = cRes.rows[0].id;

      await _insertInstallmentsAndPayments(
        client, creditId, installmentsCount, amt, approved, creditBehavior, collectorId, adminId
      );

      if (creditBehavior === 'SETTLED') {
        const settledAt = addMonths(approved, installmentsCount);
        await client.query(
          `UPDATE credits
           SET status='SETTLED', settled_at=$1, settlement_type='NORMAL', updated_at=$1
           WHERE id=$2`,
          [settledAt, creditId]
        );
      }
      return creditId;
    };

    // ── 40 créditos ──────────────────────────────────────────────────────
    // Tasas LOAN alineadas con interest_rates (semilla 03):
    //   0-100k: 2c→0.54, 3c→0.89
    //   100k-150k: 3c→0.85
    //   150k-200k: 3c→0.80, 4c→0.96
    //   200k-300k: 4c→0.96
    // Tasas SALE: product_rates definidas arriba (2c→0.48, 3c→0.80, 4c→0.96)

    // ── SETTLED SALE (8) — 4 a 6 meses atrás, todas las cuotas pagadas ──
    await createSaleCredit({ customerId: customerIds[0],  createdBy: sellerId,    approvedAt: '2025-10-30', productDesc: 'Celular Motorola Edge 30',          installmentsCount: 3, rate: 0.80, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[1],  createdBy: sellerId,    approvedAt: '2025-11-05', productDesc: 'Smart TV 43" Samsung 4K',           installmentsCount: 4, rate: 0.96, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[2],  createdBy: hybridId,    approvedAt: '2025-11-15', productDesc: 'Zapatillas Nike Air Max 270',        installmentsCount: 2, rate: 0.48, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[3],  createdBy: sellerId,    approvedAt: '2025-12-01', productDesc: 'Microondas Whirlpool 25L',           installmentsCount: 2, rate: 0.48, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[4],  createdBy: hybridId,    approvedAt: '2025-12-10', productDesc: 'Zapatillas Adidas Ultraboost',       installmentsCount: 3, rate: 0.80, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[5],  createdBy: sellerId,    approvedAt: '2026-01-08', productDesc: 'Televisor 32" Noblex HD',            installmentsCount: 2, rate: 0.48, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[6],  createdBy: hybridId,    approvedAt: '2026-01-20', productDesc: 'Celular Samsung Galaxy A54',         installmentsCount: 3, rate: 0.80, creditBehavior: 'SETTLED' });
    await createSaleCredit({ customerId: customerIds[7],  createdBy: sellerId,    approvedAt: '2026-02-05', productDesc: 'Celular Xiaomi Redmi Note 12',       installmentsCount: 2, rate: 0.48, creditBehavior: 'SETTLED' });

    // ── SETTLED LOAN (4) ─────────────────────────────────────────────────
    await createLoanCredit({ customerId: customerIds[8],  createdBy: sellerId,    approvedAt: '2025-11-20', totalAmount:  80000, installmentsCount: 3, rate: 0.89, creditBehavior: 'SETTLED' });
    await createLoanCredit({ customerId: customerIds[9],  createdBy: hybridId,    approvedAt: '2025-12-15', totalAmount: 120000, installmentsCount: 3, rate: 0.85, creditBehavior: 'SETTLED' });
    await createLoanCredit({ customerId: customerIds[10], createdBy: sellerId,    approvedAt: '2026-01-10', totalAmount:  50000, installmentsCount: 2, rate: 0.54, creditBehavior: 'SETTLED' });
    await createLoanCredit({ customerId: customerIds[11], createdBy: hybridId,    approvedAt: '2026-02-01', totalAmount: 160000, installmentsCount: 3, rate: 0.80, creditBehavior: 'SETTLED' });

    // ── ACTIVE SALE (14) — cuotas pasadas PAID, futuras PENDING ──────────
    await createSaleCredit({ customerId: customerIds[12], createdBy: sellerId,    approvedAt: '2026-01-15', productDesc: 'Notebook Lenovo IdeaPad 15"',       installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[13], createdBy: hybridId,    approvedAt: '2026-01-28', productDesc: 'Heladera Whirlpool No Frost 400L',   installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[14], createdBy: sellerId,    approvedAt: '2026-02-10', productDesc: 'Aire Acondicionado Split 3000w Noblex', installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[15], createdBy: hybridId,    approvedAt: '2026-02-20', productDesc: 'Lavarropas Automático Drean 7kg',    installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[16], createdBy: sellerId,    approvedAt: '2026-03-01', productDesc: 'Smart TV 55" LG OLED',              installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[17], createdBy: hybridId,    approvedAt: '2026-03-10', productDesc: 'Celular Motorola Edge 30',          installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[18], createdBy: sellerId,    approvedAt: '2026-03-15', productDesc: 'iPhone 14 128GB',                   installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[19], createdBy: hybridId,    approvedAt: '2026-03-20', productDesc: 'Sofá 3 cuerpos Rústico',            installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[0],  createdBy: sellerId,    approvedAt: '2026-03-25', productDesc: 'Celular Samsung Galaxy A54',         installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[1],  createdBy: hybridId,    approvedAt: '2026-04-01', productDesc: 'Zapatillas Nike Air Max 270',        installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[2],  createdBy: sellerId,    approvedAt: '2026-04-05', productDesc: 'Mesa comedor 6 sillas',              installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[3],  createdBy: hybridId,    approvedAt: '2026-04-10', productDesc: 'Celular Xiaomi Redmi Note 12',       installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[4],  createdBy: sellerId,    approvedAt: '2026-04-15', productDesc: 'Juego de dormitorio + colchón Queen', installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createSaleCredit({ customerId: customerIds[5],  createdBy: hybridId,    approvedAt: '2026-04-20', productDesc: 'Televisor 32" Noblex HD',            installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });

    // ── ACTIVE LOAN (6) ───────────────────────────────────────────────────
    await createLoanCredit({ customerId: customerIds[6],  createdBy: sellerId,    approvedAt: '2026-02-15', totalAmount: 200000, installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createLoanCredit({ customerId: customerIds[7],  createdBy: hybridId,    approvedAt: '2026-02-28', totalAmount: 150000, installmentsCount: 3, rate: 0.85, creditBehavior: 'ACTIVE' });
    await createLoanCredit({ customerId: customerIds[8],  createdBy: sellerId,    approvedAt: '2026-03-10', totalAmount: 300000, installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createLoanCredit({ customerId: customerIds[9],  createdBy: hybridId,    approvedAt: '2026-03-20', totalAmount: 100000, installmentsCount: 3, rate: 0.89, creditBehavior: 'ACTIVE' });
    await createLoanCredit({ customerId: customerIds[10], createdBy: sellerId,    approvedAt: '2026-04-01', totalAmount: 250000, installmentsCount: 4, rate: 0.96, creditBehavior: 'ACTIVE' });
    await createLoanCredit({ customerId: customerIds[11], createdBy: hybridId,    approvedAt: '2026-04-15', totalAmount: 180000, installmentsCount: 3, rate: 0.80, creditBehavior: 'ACTIVE' });

    // ── OVERDUE SALE (6) — morosos, cuotas vencidas sin pago ─────────────
    await createSaleCredit({ customerId: customerIds[25], createdBy: sellerId,    approvedAt: '2025-12-20', productDesc: 'Smart TV 43" Samsung 4K',           installmentsCount: 4, rate: 0.96, creditBehavior: 'OVERDUE' });
    await createSaleCredit({ customerId: customerIds[26], createdBy: hybridId,    approvedAt: '2026-01-05', productDesc: 'Celular Samsung Galaxy A54',         installmentsCount: 3, rate: 0.80, creditBehavior: 'OVERDUE' });
    await createSaleCredit({ customerId: customerIds[27], createdBy: sellerId,    approvedAt: '2026-01-18', productDesc: 'Heladera Whirlpool No Frost 400L',   installmentsCount: 4, rate: 0.96, creditBehavior: 'OVERDUE' });
    await createSaleCredit({ customerId: customerIds[28], createdBy: hybridId,    approvedAt: '2026-02-03', productDesc: 'Notebook Lenovo IdeaPad 15"',       installmentsCount: 4, rate: 0.96, creditBehavior: 'OVERDUE' });
    await createSaleCredit({ customerId: customerIds[29], createdBy: sellerId,    approvedAt: '2026-02-18', productDesc: 'Celular Motorola Edge 30',          installmentsCount: 3, rate: 0.80, creditBehavior: 'OVERDUE' });
    await createSaleCredit({ customerId: customerIds[12], createdBy: hybridId,    approvedAt: '2026-03-01', productDesc: 'Zapatillas Adidas Ultraboost',       installmentsCount: 3, rate: 0.80, creditBehavior: 'OVERDUE' });

    // ── OVERDUE LOAN (2) ──────────────────────────────────────────────────
    await createLoanCredit({ customerId: customerIds[25], createdBy: sellerId,    approvedAt: '2026-01-25', totalAmount:  90000, installmentsCount: 3, rate: 0.89, creditBehavior: 'OVERDUE' });
    await createLoanCredit({ customerId: customerIds[26], createdBy: hybridId,    approvedAt: '2026-02-10', totalAmount: 130000, installmentsCount: 3, rate: 0.85, creditBehavior: 'OVERDUE' });

    console.log('   ✅  40 créditos, cuotas y pagos creados.');

    // ── 7. Cierres de caja (últimos 3 días) ─────────────────────────────
    console.log('  Creando cierres de caja...');

    for (const offset of [-3, -2, -1]) {
      const regDate = dateStr(addDays(TODAY, offset));

      const already = await client.query(
        `SELECT id FROM cash_registers WHERE register_date = $1`, [regDate]
      );
      if (already.rows.length > 0) continue;

      const totals = await client.query(
        `SELECT
           COALESCE(SUM(amount_received) FILTER (WHERE payment_method='CASH'),     0)::float8 AS cash_amt,
           COALESCE(SUM(amount_received) FILTER (WHERE payment_method='TRANSFER'), 0)::float8 AS transfer_amt,
           COALESCE(SUM(amount_received), 0)::float8 AS total
         FROM payments
         WHERE status='APPROVED' AND approved_at::date = $1`,
        [regDate]
      );

      const cashAmt     = totals.rows[0].cash_amt;
      const transferAmt = totals.rows[0].transfer_amt;
      const total       = totals.rows[0].total;
      // Pequeña diferencia aleatoria para simular declaración manual
      const variance    = (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 1500);
      const declared    = Math.max(0, cashAmt + variance);
      const diff        = declared - cashAmt;
      const diffStatus  = Math.abs(diff) < 200 ? 'EXACT' : diff > 0 ? 'SURPLUS' : 'SHORTAGE';

      await client.query(
        `INSERT INTO cash_registers
           (register_date, cash_amount, transfer_amount, total_collected,
            total_outflows, declared_cash, difference, difference_status, observations, closed_by)
         VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9)`,
        [regDate, cashAmt, transferAmt, total, declared, diff, diffStatus,
         'Cierre diario — datos de prueba', adminId]
      );
    }

    await client.query('COMMIT');
    console.log('   ✅  3 cierres de caja creados.');
    console.log('');
    console.log('   ┌──────────────────────────────────────────────┐');
    console.log('   │  Usuarios (contraseña: 1234 para todos)      │');
    console.log('   │  Vendedor:          DNI 11111111             │');
    console.log('   │  Cobrador:          DNI 22222222             │');
    console.log('   │  Vendedor+Cobrador: DNI 33333333             │');
    console.log('   ├──────────────────────────────────────────────┤');
    console.log('   │  Créditos: 12 SETTLED · 20 ACTIVE · 8 VENC  │');
    console.log('   │  28 SALE (producto) + 12 LOAN (efectivo)     │');
    console.log('   └──────────────────────────────────────────────┘');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ── Helper privado: cuotas + payments ──────────────────────────────────────
async function _insertInstallmentsAndPayments(
  client, creditId, count, amt, approved, behavior, collectorId, adminId
) {
  for (let i = 0; i < count; i++) {
    const dueDate  = addMonths(approved, i + 1);
    const isPast   = dueDate < TODAY;

    let instStatus, amountPaid;
    if (behavior === 'SETTLED') {
      instStatus  = 'PAID';
      amountPaid  = amt;
    } else if (behavior === 'ACTIVE') {
      instStatus  = isPast ? 'PAID' : 'PENDING';
      amountPaid  = isPast ? amt    : 0;
    } else { // OVERDUE
      instStatus  = isPast ? 'OVERDUE' : 'PENDING';
      amountPaid  = 0;
    }

    const iRes = await client.query(
      `INSERT INTO installments
         (credit_id, installment_number, due_date, amount_due, original_amount,
          amount_paid, status, payment_frequency, created_at)
       VALUES ($1,$2,$3,$4,$4,$5,$6,'MONTHLY',$7)
       RETURNING id`,
      [creditId, i + 1, dateStr(dueDate), amt, amountPaid, instStatus, approved]
    );
    const installmentId = iRes.rows[0].id;

    // Payment para cuotas PAID
    if (instStatus === 'PAID') {
      // Pago 1-5 días antes del vencimiento
      const payOffset = Math.floor(Math.random() * 5) + 1;
      const payDate   = addDays(dueDate, -payOffset);
      const method    = Math.random() > 0.45 ? 'CASH' : 'TRANSFER';

      await client.query(
        `INSERT INTO payments
           (installment_id, collector_id, amount_received, payment_method,
            status, approved_by, approved_at, created_at)
         VALUES ($1,$2,$3,$4,'APPROVED',$5,$6,$6)`,
        [installmentId, collectorId, amt, method, adminId, payDate]
      );
    }
  }
}

module.exports = seed;
