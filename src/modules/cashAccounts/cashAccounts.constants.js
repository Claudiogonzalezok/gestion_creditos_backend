// Tipos de movimiento de Caja General: única fuente de verdad para el
// validador de rutas y el service.

// IMP-6: SALARY_PAYMENT NO se acepta desde el endpoint público — debe pasar
// por commissions.liquidate, que es la única fuente con trazabilidad de
// período liquidado y mata el riesgo de doble pago (manual + liquidación).
const PUBLIC_MOVEMENT_TYPES = ['SUPPLIER_PAYMENT', 'EXPENSE', 'ADJUSTMENT', 'MANUAL_INCOME'];

// Todos los tipos existentes (aceptados como filtro de listado).
const ALL_MOVEMENT_TYPES = ['DROP_IN', 'SALARY_PAYMENT', ...PUBLIC_MOVEMENT_TYPES];

module.exports = { PUBLIC_MOVEMENT_TYPES, ALL_MOVEMENT_TYPES };
