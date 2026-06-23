const pool = require("../../config/db");

// =============================================================================
// SELECT_COLLECTION_REFERENCE — expresión derivada que arma una frase única
// lista para mostrar: "Cuota X de N · crédito de <productos>" o
// "Cuota X de N · préstamo de $<monto>".
//
// Reutilizada por findInstallmentsForSheet y findById para garantizar el mismo
// wording en planilla del cobrador, admin y diálogo de cobro.
//
// Detalles:
//   - SALE: muestra hasta 2 títulos DISTINTOS de producto, y agrega "y N más"
//     si hay más. Cada credit_products es una unidad física (puede repetirse el
//     mismo producto N veces); por eso usamos DISTINCT.
//     Cadena de FKs: credit_products → product_units → product_variants → products.
//   - LOAN: formato moneda Argentino sin depender de lc_numeric del servidor —
//     to_char en formato US y translate(',.', '.,') lo invierte.
//   - Asume JOIN previo: credits AS c, installments AS i.
// =============================================================================
const SELECT_COLLECTION_REFERENCE = `
  CASE
    WHEN c.type = 'SALE' THEN
      'Cuota ' || i.installment_number::text || ' de ' || c.installments_count::text ||
      ' · crédito de ' || COALESCE((
        SELECT
          CASE
            WHEN array_length(t.titles, 1) <= 2
              THEN array_to_string(t.titles, ' + ')
            ELSE
              array_to_string(t.titles[1:2], ' + ') ||
              ' y ' || (array_length(t.titles, 1) - 2)::text || ' más'
          END
        FROM (
          SELECT array_agg(DISTINCT p.title ORDER BY p.title) AS titles
          FROM credit_products cp
          JOIN product_units    pu ON pu.id = cp.product_unit_id
          JOIN product_variants pv ON pv.id = pu.variant_id
          JOIN products         p  ON p.id  = pv.product_id
          WHERE cp.credit_id = c.id
        ) t
      ), 'artículos')
    ELSE
      'Cuota ' || i.installment_number::text || ' de ' || c.installments_count::text ||
      ' · préstamo de $' ||
      translate(to_char(round(c.total_amount), 'FM999G999G999G990'), ',.', '.,')
  END
`;

// =============================================================================
// CTE latest_next_visit — construida y documentada de forma aislada
//
// Fuente de verdad: ÚLTIMO registro creado por cuota (created_at DESC).
// NO la fecha más lejana — el último intento registrado es el que manda.
//
// Unifica dos orígenes:
//   payments        (status IN ('PENDING','APPROVED'), next_visit_date IS NOT NULL, is_reversal=FALSE)
//   collection_attempts (next_visit_date IS NOT NULL)
//
// IMPORTANTE: se consideran pagos APPROVED además de PENDING. Un cobro parcial
// aprobado deja la cuota PARTIAL con saldo y la fecha de próxima visita pactada
// con el cliente sigue vigente — la agenda debe respetarla. Si solo miráramos
// PENDING, al aprobar el pago la cuota perdería su agenda y volvería a "vencidas"
// antes de la fecha acordada. Los REJECTED quedan fuera (no agendan nada).
//
// Resultado por cuota: installment_id, next_visit_date más reciente.
// =============================================================================
const CTE_LATEST_NEXT_VISIT = `
  latest_next_visit AS (
    SELECT DISTINCT ON (installment_id)
      installment_id,
      next_visit_date
    FROM (
      SELECT installment_id, next_visit_date, created_at
      FROM payments
      WHERE status IN ('PENDING','APPROVED')
        AND next_visit_date IS NOT NULL
        AND is_reversal = FALSE
      UNION ALL
      SELECT installment_id, next_visit_date, created_at
      FROM collection_attempts
      WHERE next_visit_date IS NOT NULL
        AND voided_at IS NULL
    ) combined_visits
    ORDER BY installment_id, created_at DESC
  )
`;

// =============================================================================
// CTE latest_antecedent — construida y documentada de forma aislada
//
// Snapshot del último intento previo por cuota, para mostrar contexto en planilla.
// Incluye NOT_FOUND aunque no tenga next_visit_date (se muestra igual como antecedente).
//
// Unifica dos orígenes:
//   payments (next_visit_date IS NOT NULL, is_reversal=FALSE) → antecedent_type = 'PARTIAL_PAYMENT'
//   collection_attempts (todos)                               → antecedent_type = attempt_type
//
// Resultado: installment_id, antecedent_type, antecedent_date, antecedent_notes.
// =============================================================================
const CTE_LATEST_ANTECEDENT = `
  latest_antecedent AS (
    SELECT DISTINCT ON (installment_id)
      installment_id,
      antecedent_id,
      antecedent_type,
      antecedent_date,
      antecedent_notes
    FROM (
      SELECT
        p.installment_id,
        p.id                AS antecedent_id,
        'PARTIAL_PAYMENT'   AS antecedent_type,
        p.created_at::date  AS antecedent_date,
        p.notes             AS antecedent_notes,
        p.created_at
      FROM payments p
      WHERE p.next_visit_date IS NOT NULL
        AND p.is_reversal = FALSE
      UNION ALL
      SELECT
        ca.installment_id,
        ca.id               AS antecedent_id,
        ca.attempt_type     AS antecedent_type,
        ca.created_at::date AS antecedent_date,
        ca.notes            AS antecedent_notes,
        ca.created_at
      FROM collection_attempts ca
      WHERE ca.voided_at IS NULL
    ) combined_antecedents
    ORDER BY installment_id, created_at DESC
  )
`;

// =============================================================================
// REGLAS OPERATIVAS DE INCLUSIÓN EN PLANILLA (referencia normativa)
// =============================================================================
// 1. Una cuota con próxima visita FUTURA queda fuera hasta la fecha pactada.
//    La agenda comprometida pisa al vencimiento como criterio operativo.
//
// 2. Una visita VENCIDA (next_visit_date < target_date) deja automáticamente
//    de actuar como agenda válida; la cuota vuelve al flujo de mora.
//
// 3. Las cuotas PARTIAL se consideran pendientes mientras exista saldo
//    ((amount_due - amount_paid) > 0). El status NO es la fuente de verdad
//    por sí solo — el cinturón financiero blinda contra cuotas "fantasma"
//    con status colgando.
//
// 4. La vencidez se deriva de due_date < target_date, NO del status OVERDUE
//    persistido. Esto evita inconsistencias si la cron no corrió.
//
// 5. Una cuota aparece UNA sola vez aunque cumpla múltiples razones de
//    inclusión. Prioridad de inclusión (qué razón se reporta):
//        OVERDUE / OVERDUE_UNSCHEDULED > DUE_TODAY > SCHEDULED_VISIT > ALL_PENDING
//
// 6. El ORDEN visual usa una prioridad DISTINTA (op_priority):
//        1 = visita pactada · 2 = mora · 3 = vence hoy · 4 = resto
//    Operativamente el cobrador resuelve compromisos primero, después mora.
//
// 7. inclusion_reason / op_priority / remaining_amount se PERSISTEN en
//    collection_sheet_details como snapshot histórico — la planilla impresa
//    no cambia aunque después se modifiquen visitas o pagos. En cambio
//    next_visit_date y antecedente siguen vivos en findById porque el
//    cobrador necesita ver la gestión más reciente.
//
// 8. La fuente de verdad de la última visita es created_at DESC (última
//    gestión registrada), NO next_visit_date DESC (fecha más lejana). Esto
//    permite que un cambio de agenda pise correctamente al anterior.
//
// 9. Una cuota con pre-carga PENDING viva (cobro sin aprobar/rechazar) queda
//    FUERA del recorrido hasta que el admin la resuelva. Está "en proceso de
//    doble control": re-incluirla generaría re-visitas y dobles pre-cargas.
//    Si la pre-carga se rechaza, la cuota vuelve a aparecer; si se aprueba y
//    salda, sale por saldo 0. Coherente con cajas por jornada (las pre-cargas
//    cruzan de un día a otro).
//
// 10. La agenda (latest_next_visit) considera pagos PENDING y APPROVED: un
//     cobro PARCIAL aprobado conserva la fecha pactada con el cliente. Una
//     visita pactada para HOY es trabajo "del día" → entra por TODAY y
//     TODAY_AND_OVERDUE, NO por "solo vencidas" (OVERDUE). TODAY no incluye
//     mora vieja sin agenda: eso pertenece al filtro OVERDUE.
// =============================================================================

/**
 * Busca cuotas para incluir en una planilla, aplicando las reglas operativas.
 *
 * Implementación: CTEs semánticas por motivo de inclusión, combinadas según
 * el filter, deduplicadas con ROW_NUMBER por prioridad explícita y ordenadas
 * por prioridad operativa.
 *
 * @param {string} collectorId
 * @param {string} date - Fecha objetivo (YYYY-MM-DD).
 * @param {string} filter - TODAY | OVERDUE | TODAY_AND_OVERDUE | ALL_PENDING
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<Array>}
 */
const findInstallmentsForSheet = async (
  collectorId,
  date,
  filter,
  db = pool,
) => {
  const params = [collectorId, date, filter || "ALL_PENDING"];

  const r = await db.query(
    `WITH
      ${CTE_LATEST_NEXT_VISIT},
      ${CTE_LATEST_ANTECEDENT},

      -- Universo base: cuotas vigentes con saldo > 0 (regla 3) que NO estén
      -- esperando aprobación de un cobro (regla 9). Una cuota con pre-carga
      -- PENDING viva está "en proceso de doble control": no se vuelve a poner
      -- en el recorrido hasta que el admin la apruebe o rechace. Esto evita
      -- re-visitas y dobles pre-cargas, y respeta el modelo de cajas por jornada
      -- (las pre-cargas pueden cruzar de un día a otro).
      candidates AS (
        SELECT i.id                AS installment_id,
               i.due_date,
               i.amount_due,
               i.amount_paid
        FROM installments i
        JOIN credits   c  ON c.id  = i.credit_id
        JOIN customers cu ON cu.id = c.customer_id
        WHERE c.status = 'ACTIVE'
          AND cu.assigned_collector_id = $1
          AND i.status IN ('PENDING','PARTIAL','OVERDUE')
          AND (i.amount_due - i.amount_paid) > 0
          AND NOT EXISTS (
            SELECT 1 FROM payments p
            WHERE p.installment_id = i.id
              AND p.status = 'PENDING'
              AND p.is_reversal = FALSE
          )
      ),

      -- Razones de inclusión (cada una resuelve un "por qué entra")
      -- scheduled_today: visita pactada exactamente para target_date.
      scheduled_today AS (
        SELECT c.installment_id
        FROM candidates c
        JOIN latest_next_visit lnv ON lnv.installment_id = c.installment_id
        WHERE lnv.next_visit_date::date = $2::date
      ),
      -- due_today: vence hoy y NO hay agenda futura (regla 1).
      due_today AS (
        SELECT c.installment_id
        FROM candidates c
        LEFT JOIN latest_next_visit lnv ON lnv.installment_id = c.installment_id
        WHERE c.due_date::date = $2::date
          AND (lnv.next_visit_date IS NULL OR lnv.next_visit_date::date <= $2::date)
      ),
      -- overdue: vencida y sin agenda futura (incluye visita hoy o vencida).
      overdue AS (
        SELECT c.installment_id
        FROM candidates c
        LEFT JOIN latest_next_visit lnv ON lnv.installment_id = c.installment_id
        WHERE c.due_date::date < $2::date
          AND (lnv.next_visit_date IS NULL OR lnv.next_visit_date::date <= $2::date)
      ),
      -- overdue_unscheduled: vencida sin agenda vigente (regla 2).
      -- Subconjunto de overdue que excluye visita = target_date (esa la trae
      -- scheduled_today). Usado por filter_today.
      overdue_unscheduled AS (
        SELECT c.installment_id
        FROM candidates c
        LEFT JOIN latest_next_visit lnv ON lnv.installment_id = c.installment_id
        WHERE c.due_date::date < $2::date
          AND (lnv.next_visit_date IS NULL OR lnv.next_visit_date::date < $2::date)
      ),

      -- Composición por filter — incl_prio define qué razón gana en caso de
      -- overlap (regla 5).
      -- "Solo vencidas" (OVERDUE) usa overdue_unscheduled: vencidas SIN visita
      -- de hoy ni futura (incluye visita vencida, que volvió a mora). Una cuota
      -- con próxima visita agendada para HOY es trabajo "del día", no una
      -- vencida pura, así que entra por TODAY y TODAY_AND_OVERDUE, no acá
      -- (regla 10).
      filter_overdue AS (
        SELECT installment_id, 'OVERDUE'         AS reason, 1 AS incl_prio FROM overdue_unscheduled
      ),
      filter_today AS (
        SELECT installment_id, 'DUE_TODAY'           AS reason, 2 AS incl_prio FROM due_today
        UNION ALL
        SELECT installment_id, 'SCHEDULED_VISIT'     AS reason, 3 AS incl_prio FROM scheduled_today
      ),
      filter_today_overdue AS (
        SELECT installment_id, 'OVERDUE'         AS reason, 1 AS incl_prio FROM overdue
        UNION ALL
        SELECT installment_id, 'DUE_TODAY'       AS reason, 2 AS incl_prio FROM due_today
        UNION ALL
        SELECT installment_id, 'SCHEDULED_VISIT' AS reason, 3 AS incl_prio FROM scheduled_today
      ),
      filter_all_pending AS (
        SELECT installment_id, 'ALL_PENDING' AS reason, 4 AS incl_prio FROM candidates
      ),

      selected_raw AS (
        SELECT * FROM filter_overdue       WHERE $3 = 'OVERDUE'
        UNION ALL
        SELECT * FROM filter_today         WHERE $3 = 'TODAY'
        UNION ALL
        SELECT * FROM filter_today_overdue WHERE $3 = 'TODAY_AND_OVERDUE'
        UNION ALL
        SELECT * FROM filter_all_pending   WHERE $3 = 'ALL_PENDING'
      ),

      -- Dedupe por incl_prio (regla 5) + op_priority derivada (regla 6).
      -- op_priority se calcula sobre la cuota deduplicada considerando si
      -- tiene visita hoy, independiente del reason ganador.
      selected AS (
        SELECT
          s.installment_id,
          s.reason,
          CASE
            WHEN EXISTS (SELECT 1 FROM scheduled_today st WHERE st.installment_id = s.installment_id) THEN 1
            WHEN s.reason IN ('OVERDUE','OVERDUE_UNSCHEDULED') THEN 2
            WHEN s.reason = 'DUE_TODAY' THEN 3
            ELSE 4
          END AS op_priority
        FROM (
          SELECT installment_id, reason, incl_prio,
            ROW_NUMBER() OVER (
              PARTITION BY installment_id ORDER BY incl_prio
            ) AS rn
          FROM selected_raw
        ) s
        WHERE s.rn = 1
      )

     SELECT
       i.id                  AS installment_id,
       i.installment_number,
       i.due_date,
       i.amount_due::float8,
       i.amount_paid::float8,
       (i.amount_due - i.amount_paid)::float8 AS remaining_amount,
       i.penalty_amount::float8,
       i.status              AS installment_status,
       c.id                  AS credit_id,
       c.type                AS credit_type,
       cu.id                 AS customer_id,
       cu.full_name          AS customer_name,
       cu.phone              AS customer_phone,
       cu.address            AS customer_address,
       cu.dni                AS customer_dni,
       lnv.next_visit_date,
       s.reason              AS inclusion_reason,
       s.op_priority,
       CASE
         WHEN s.reason = 'SCHEDULED_VISIT' THEN 'VISIT_DATE'
         ELSE 'DUE_DATE'
       END                   AS inclusion_criteria,
       la.antecedent_id,
       la.antecedent_type,
       la.antecedent_date,
       la.antecedent_notes,
       EXISTS (
         SELECT 1 FROM payments p
         WHERE p.installment_id = i.id
           AND p.status = 'PENDING'
           AND p.is_reversal = FALSE
       )                     AS has_pending_payment,
       ${SELECT_COLLECTION_REFERENCE} AS collection_reference
     FROM selected s
     JOIN installments i ON i.id = s.installment_id
     JOIN credits   c  ON c.id  = i.credit_id
     JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN latest_next_visit lnv ON lnv.installment_id = i.id
     LEFT JOIN latest_antecedent la  ON la.installment_id  = i.id
     -- Agrupación operativa: alfabético por cliente, luego por crédito, luego
     -- por número de cuota. El cobrador resuelve un cliente UNA vez con todas
     -- sus cuotas. cu.id desempata homónimos y c.id estabiliza el orden entre
     -- créditos del mismo cliente.
     ORDER BY
       cu.full_name,
       cu.id,
       c.id,
       i.installment_number,
       i.due_date`,
    params,
  );
  return r.rows;
};

/**
 * Crea la cabecera de una planilla de cobro persistiendo snapshot de identidad:
 *   · collector_name_snapshot — nombre del cobrador AL MOMENTO de la generación.
 *   · generated_by_name_snapshot — admin generador AL MOMENTO de la generación.
 *   · snapshot_version = 1 — indica que la planilla tiene snapshot completo.
 * Si los users cambian de nombre después, la planilla mantiene la identidad
 * original (documento histórico).
 *
 * @param {{ collectorId, date, filter, adminId }} payload
 * @param {import('pg').PoolClient} [db=pool]
 * @returns {Promise<object>}
 */
const create = async ({ collectorId, date, filter, adminId }, db = pool) => {
  const r = await db.query(
    `INSERT INTO collection_sheets (
       collector_id, sheet_date, filter_used, generated_by,
       collector_name_snapshot, generated_by_name_snapshot, snapshot_version
     )
     SELECT $1, $2, $3, $4,
            (SELECT full_name FROM users WHERE id = $1),
            (SELECT full_name FROM users WHERE id = $4),
            1
     RETURNING id, collector_id, sheet_date, filter_used, generated_by, status, created_at,
               snapshot_version`,
    [collectorId, date, filter || "ALL_PENDING", adminId],
  );
  return r.rows[0];
};

/**
 * Inserta los detalles de una planilla persistiendo el snapshot histórico
 * (planned_amount, inclusion_criteria, inclusion_reason, op_priority,
 * remaining_amount_snapshot, antecedente).
 *
 * Los items ya vienen ordenados por findInstallmentsForSheet según
 * op_priority + next_visit_date + due_date + customer_name. El order_number
 * se asigna 1..N en ese orden y se respeta en cualquier lectura posterior.
 *
 * @param {string} sheetId
 * @param {Array<object>} items
 * @param {import('pg').PoolClient} [db=pool]
 */
/**
 * Inserta los detalles de la planilla con SNAPSHOT TOTAL al momento de
 * generación. Todos los datos visibles en la planilla quedan persistidos
 * en collection_sheet_details — la planilla es inmutable desde este insert.
 *
 * Si alguno de los campos cambia después (mora aplicada, teléfono editado,
 * pagos nuevos, antecedentes nuevos), la planilla MANTIENE los valores de
 * este snapshot. Las gestiones del día se ven en otra capa (queries live
 * sobre payments/collection_attempts).
 *
 * El trigger trg_csd_immutability rechaza cualquier UPDATE futuro sobre
 * estos campos como defensa adicional a nivel DB.
 *
 * @param {string} sheetId
 * @param {Array<object>} items - Filas devueltas por findInstallmentsForSheet,
 *                                ya con todos los campos snapshot calculados.
 * @param {import('pg').PoolClient} [db=pool]
 */
const createDetails = async (sheetId, items, db = pool) => {
  if (!items.length) return;
  const COLS_PER_ROW = 26;
  const values = items
    .map((_, i) => {
      const b = i * COLS_PER_ROW;
      const ph = [];
      for (let n = 1; n <= COLS_PER_ROW; n++) ph.push(`$${b + n}`);
      return `(${ph.join(", ")})`;
    })
    .join(", ");
  const params = items.flatMap((item, i) => [
    sheetId,
    item.installment_id,
    i + 1,
    item.amount_due, // planned_amount
    item.inclusion_criteria || "DUE_DATE",
    item.antecedent_type || null,
    item.antecedent_date || null,
    item.antecedent_notes || null,
    item.inclusion_reason || null,
    item.op_priority ?? null,
    item.remaining_amount ?? null,
    // Snapshots nuevos (migration 020)
    item.installment_number,
    item.due_date,
    item.amount_due,
    item.amount_paid,
    item.penalty_amount,
    item.installment_status,
    item.credit_type,
    item.customer_name,
    item.customer_phone,
    item.customer_address,
    item.customer_dni,
    item.next_visit_date,
    item.has_pending_payment === true,
    item.collection_reference,
    item.antecedent_id || null,
  ]);
  await db.query(
    `INSERT INTO collection_sheet_details (
       sheet_id, installment_id, order_number, planned_amount,
       inclusion_criteria, antecedent_type, antecedent_date, antecedent_notes,
       inclusion_reason, op_priority, remaining_amount_snapshot,
       installment_number_snapshot, due_date_snapshot,
       amount_due_snapshot, amount_paid_snapshot, penalty_amount_snapshot,
       installment_status_snapshot, credit_type_snapshot,
       customer_name_snapshot, customer_phone_snapshot, customer_address_snapshot,
       customer_dni_snapshot,
       next_visit_date_snapshot, has_pending_payment_snapshot,
       collection_reference_snapshot, antecedent_id_snapshot
     ) VALUES ${values}`,
    params,
  );
};

/**
 * Marca una planilla como REGENERATED (soft-delete).
 * Los collection_sheet_details NO se eliminan — el historial se preserva completo.
 * El trigger trg_collection_sheet_immutability valida la transición.
 * @param {string} id - ID de la planilla a marcar.
 * @param {import('pg').PoolClient} client
 */
const markSheetAsRegenerated = async (id, client) => {
  await client.query(
    `UPDATE collection_sheets SET status = 'REGENERATED' WHERE id = $1`,
    [id],
  );
};

/**
 * Cierra la planilla del día. Solo permitido si status='ACTIVE'.
 * El trigger valida la transición; acá agregamos guard SQL adicional con
 * RETURNING para detectar si se cerró efectivamente (defensa en profundidad).
 * @param {string} id
 * @param {string} adminId - quien cierra.
 * @returns {Promise<boolean>} true si la transición ocurrió.
 */
const closeSheet = async (id, adminId, db = pool) => {
  const r = await db.query(
    `UPDATE collection_sheets
     SET status = 'CLOSED', closed_at = NOW(), closed_by = $2
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id`,
    [id, adminId],
  );
  return r.rowCount > 0;
};

/**
 * Cancela la planilla. Solo permitido si status='ACTIVE'.
 * @returns {Promise<boolean>} true si la transición ocurrió.
 */
const cancelSheet = async (id, db = pool) => {
  const r = await db.query(
    `UPDATE collection_sheets SET status = 'CANCELLED'
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id`,
    [id],
  );
  return r.rowCount > 0;
};

/**
 * Lista planillas con filtros opcionales.
 * Por defecto devuelve solo ACTIVE; con includeRegenerated=true suma las REGENERATED
 * para auditoría (filtro exclusivo del Admin, restringido en service).
 * @param {{ collectorId?: string, date?: string, includeRegenerated?: boolean }} filters
 * @returns {Promise<Array>}
 */
const findAll = async ({ collectorId, date, includeRegenerated } = {}) => {
  const statusFilter = includeRegenerated
    ? `cs.status IN ('ACTIVE','REGENERATED')`
    : `cs.status = 'ACTIVE'`;
  let q = `
    SELECT cs.id, cs.sheet_date, cs.filter_used, cs.status, cs.created_at,
           cs.collector_id,
           u.full_name AS collector_name,
           COUNT(csd.id)::int AS total_items
    FROM collection_sheets cs
    JOIN users u ON u.id = cs.collector_id
    LEFT JOIN collection_sheet_details csd ON csd.sheet_id = cs.id
    WHERE ${statusFilter}`;
  const params = [];
  if (collectorId) {
    params.push(collectorId);
    q += ` AND cs.collector_id = $${params.length}`;
  }
  if (date) {
    params.push(date);
    q += ` AND cs.sheet_date::date = $${params.length}::date`;
  }
  q += ` GROUP BY cs.id, u.full_name ORDER BY cs.created_at DESC`;
  return (await pool.query(q, params)).rows;
};

/**
 * Busca la planilla ACTIVE para un cobrador en una fecha dada.
 * Específicamente IGNORA las REGENERATED — solo cuenta como "conflicto" una
 * planilla vigente, no histórico de regeneraciones previas.
 * Se usa para el modo skip_if_exists del service.generate y para informar al
 * admin antes de regenerar.
 * @param {string} collectorId
 * @param {string} date - YYYY-MM-DD
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<{ id, sheet_date, created_at, generated_by_name }|null>}
 */
const findActiveByCollectorAndDate = async (collectorId, date, db = pool) => {
  const r = await db.query(
    `SELECT cs.id,
            cs.sheet_date,
            cs.created_at,
            adm.full_name AS generated_by_name
     FROM collection_sheets cs
     JOIN users adm ON adm.id = cs.generated_by
     WHERE cs.collector_id = $1
       AND cs.sheet_date::date = $2::date
       AND cs.status = 'ACTIVE'
     LIMIT 1`,
    [collectorId, date],
  );
  return r.rows[0] || null;
};

/**
 * Obtiene una planilla por ID con su detalle.
 *
 * Estrategia de lectura por snapshot_version:
 *   · v1+ (migration 020+): lee EXCLUSIVAMENTE del snapshot persistido en
 *     collection_sheet_details. Sin JOINs a installments/customers/credits.
 *     Sin CTEs que recalculen antecedentes/visitas. La planilla es un
 *     documento histórico inmutable.
 *   · v0 (legacy pre-020): fallback a JOINs live para que las planillas
 *     viejas sigan siendo legibles, aunque pueden mostrar inconsistencias
 *     porque sus datos no fueron snapshoteados. Esto se documenta en
 *     docs/installments-model.md.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
const findById = async (id) => {
  const sheetRes = await pool.query(
    `SELECT cs.id, cs.sheet_date, cs.filter_used, cs.status, cs.created_at,
            cs.closed_at, cs.closed_by, cs.snapshot_version,
            cs.sent_at, cs.sent_by,
            cs.collector_id,
            (cs.sheet_date = CURRENT_DATE) AS is_today,
            COALESCE(cs.collector_name_snapshot,    u.full_name)   AS collector_name,
            COALESCE(cs.generated_by_name_snapshot, adm.full_name) AS generated_by_name
     FROM collection_sheets cs
     JOIN users u   ON u.id  = cs.collector_id
     JOIN users adm ON adm.id = cs.generated_by
     WHERE cs.id = $1`,
    [id],
  );
  if (!sheetRes.rows.length) return null;
  // is_today es interno (decide si adjuntar capa live); no forma parte del contrato.
  const { is_today: isToday, ...sheet } = sheetRes.rows[0];

  const isV1 = sheet.snapshot_version >= 1;

  let detailsRes;
  if (isV1) {
    // ── Lectura PURA del snapshot — planilla inmutable. ───────────────────
    // customer_dni se incluyó al snapshot (csd.customer_dni_snapshot) post-merge
    // con feat sent_at: el dni es identidad fija, pero por consistencia con el
    // resto de campos del cliente, lo congelamos también en csd.
    detailsRes = await pool.query(
      `SELECT csd.order_number,
              csd.installment_id,
              csd.installment_number_snapshot AS installment_number,
              csd.due_date_snapshot           AS due_date,
              csd.amount_due_snapshot::float8 AS amount_due,
              csd.amount_paid_snapshot::float8 AS amount_paid,
              csd.penalty_amount_snapshot::float8 AS penalty_amount,
              csd.installment_status_snapshot AS installment_status,
              csd.credit_type_snapshot        AS credit_type,
              csd.customer_name_snapshot      AS customer_name,
              csd.customer_phone_snapshot     AS customer_phone,
              csd.customer_address_snapshot   AS customer_address,
              csd.customer_dni_snapshot       AS customer_dni,
              csd.next_visit_date_snapshot    AS next_visit_date,
              csd.has_pending_payment_snapshot AS has_pending_payment,
              csd.collection_reference_snapshot AS collection_reference,
              csd.planned_amount::float8,
              csd.remaining_amount_snapshot::float8 AS remaining_amount,
              csd.inclusion_criteria,
              csd.inclusion_reason,
              csd.op_priority,
              csd.antecedent_id_snapshot AS antecedent_id,
              csd.antecedent_type,
              csd.antecedent_date,
              csd.antecedent_notes,
              csd.management_status
       FROM collection_sheet_details csd
       WHERE csd.sheet_id = $1
       ORDER BY csd.order_number`,
      [id],
    );
  } else {
    // ── Fallback LEGACY — solo para planillas pre-020. ─────────────────────
    // Estos datos NO son auditables: reflejan estado actual de las tablas
    // live, no el snapshot del día de generación.
    detailsRes = await pool.query(
      `WITH
        ${CTE_LATEST_NEXT_VISIT},
        ${CTE_LATEST_ANTECEDENT}
       SELECT csd.order_number,
              csd.planned_amount::float8,
              csd.inclusion_criteria,
              csd.inclusion_reason,
              csd.op_priority,
              csd.remaining_amount_snapshot::float8 AS remaining_amount,
              la.antecedent_id,
              la.antecedent_type,
              la.antecedent_date,
              la.antecedent_notes,
              csd.management_status,
              i.id AS installment_id,
              i.installment_number,
              i.due_date,
              i.amount_due::float8,
              i.amount_paid::float8,
              i.penalty_amount::float8,
              i.status AS installment_status,
              c.id AS credit_id,
              c.type AS credit_type,
              cu.full_name AS customer_name,
              cu.phone AS customer_phone,
              cu.address AS customer_address,
              cu.dni AS customer_dni,
              lnv.next_visit_date,
              EXISTS (
                SELECT 1 FROM payments p
                WHERE p.installment_id = i.id
                  AND p.status = 'PENDING'
                  AND p.is_reversal = FALSE
              ) AS has_pending_payment,
              ${SELECT_COLLECTION_REFERENCE} AS collection_reference
       FROM collection_sheet_details csd
       JOIN installments i ON i.id  = csd.installment_id
       JOIN credits c      ON c.id  = i.credit_id
       JOIN customers cu   ON cu.id = c.customer_id
       LEFT JOIN latest_next_visit lnv ON lnv.installment_id = i.id
       LEFT JOIN latest_antecedent la  ON la.installment_id  = i.id
       WHERE csd.sheet_id = $1
       ORDER BY csd.order_number`,
      [id],
    );
  }

  const items = detailsRes.rows;

  // ── Capa LIVE separada ───────────────────────────────────────────────────────
  // El snapshot es inmutable, pero el cobrador necesita ver el estado VIVO de la
  // gestión del día para decidir qué botones habilitar (cobrar / no pagó / no
  // encontrado / deshacer). Esa info NUNCA se mezcla con el snapshot: viaja en un
  // sub-objeto `live` aparte, y SOLO cuando la planilla es operable hoy
  // (ACTIVE + sheet_date = CURRENT_DATE). Para planillas cerradas, regeneradas o
  // de otro día, live = null → el frontend la trata como documento read-only.
  const liveEnabled = sheet.status === "ACTIVE" && isToday === true;
  if (liveEnabled && items.length) {
    const installmentIds = items.map((it) => it.installment_id);
    const liveRes = await pool.query(
      `SELECT i.id AS installment_id,
              i.status                AS installment_status,
              i.amount_due::float8    AS amount_due,
              i.amount_paid::float8   AS amount_paid,
              i.penalty_amount::float8 AS penalty_amount,
              EXISTS (
                SELECT 1 FROM payments p
                WHERE p.installment_id = i.id
                  AND p.status = 'PENDING'
                  AND p.is_reversal = FALSE
              ) AS has_pending_payment,
              ca.id           AS today_attempt_id,
              ca.attempt_type AS today_attempt_type
       FROM installments i
       LEFT JOIN LATERAL (
         SELECT a.id, a.attempt_type
         FROM collection_attempts a
         WHERE a.installment_id = i.id
           AND a.voided_at IS NULL
           AND a.created_at::date = CURRENT_DATE
           -- SCHEDULED_VISIT es una gestión administrativa de agenda, no un
           -- intento de campo del cobrador: queda fuera del estado vivo del día.
           AND a.attempt_type <> 'SCHEDULED_VISIT'
         ORDER BY a.created_at DESC
         LIMIT 1
       ) ca ON TRUE
       WHERE i.id = ANY($1::uuid[])`,
      [installmentIds],
    );
    const liveById = new Map(
      liveRes.rows.map((r) => [
        r.installment_id,
        {
          // Estado VIVO de la cuota — refleja el progreso real del día, a
          // diferencia del snapshot (congelado al generar). El admin lo usa para
          // mostrar el estado actual y filtrar por PARTIAL/PAID.
          installment_status: r.installment_status,
          amount_due: r.amount_due,
          amount_paid: r.amount_paid,
          penalty_amount: r.penalty_amount,
          has_pending_payment: r.has_pending_payment,
          today_attempt_id: r.today_attempt_id,
          today_attempt_type: r.today_attempt_type,
        },
      ]),
    );
    for (const it of items) {
      it.live = liveById.get(it.installment_id) || {
        installment_status: null,
        amount_due: null,
        amount_paid: null,
        penalty_amount: null,
        has_pending_payment: false,
        today_attempt_id: null,
        today_attempt_type: null,
      };
    }
  } else {
    for (const it of items) it.live = null;
  }

  return { ...sheet, items };
};

/**
 * Devuelve clientes activos con cuotas pendientes sin cobrador asignado.
 * Alerta global del sistema (CU14-D): independiente del cobrador que genera la planilla.
 * @returns {Promise<Array<{ customer_id, full_name, pending_count }>>}
 */
const findUnassignedCustomersWithPending = async () => {
  const r = await pool.query(
    `SELECT cu.id AS customer_id, cu.full_name, COUNT(i.id)::int AS pending_count
     FROM customers cu
     JOIN credits c   ON c.customer_id = cu.id
     JOIN installments i ON i.credit_id = c.id
     WHERE cu.assigned_collector_id IS NULL
       AND c.status = 'ACTIVE'
       AND i.status IN ('PENDING','OVERDUE','PARTIAL')
     GROUP BY cu.id, cu.full_name
     ORDER BY cu.full_name`,
  );
  return r.rows;
};

/**
 * Marca una planilla como enviada al cobrador.
 * @param {string} id - ID de la planilla.
 * @param {string} adminId - ID del admin que realiza el envío.
 * @returns {Promise<{ id, sent_at }|null>} Fila actualizada o null si no existe/no es ACTIVE.
 */
const markAsSent = async (id, adminId) => {
  const r = await pool.query(
    `UPDATE collection_sheets
     SET sent_at = NOW(), sent_by = $2
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING id, sent_at`,
    [id, adminId],
  );
  return r.rows[0] || null;
};

/**
 * Hook de gestión: actualiza management_status de la fila de planilla
 * activa de HOY para (collector, installment).
 *
 * Filosofía: cada vez que el cobrador hace algo operativo sobre una cuota
 * (registra un attempt, hace una pre-carga, el admin aprueba/revierte un
 * pago), el management_status de su planilla del día refleja el resultado.
 *
 * Guarda combinada con el trigger trg_csd_immutability:
 *   · WHERE filtra a planillas ACTIVE del día actual (sin esto, no haríamos
 *     no-op silencioso para planillas viejas o cerradas).
 *   · El trigger DB también valida ACTIVE + sheet_date=CURRENT_DATE como
 *     defense-in-depth — si por race el sheet pasó a CLOSED entre planner
 *     y execution, el trigger lanza RAISE y la transacción rollback.
 *
 * NO falla si no hay planilla del día — el cobrador puede operar sobre
 * cuotas sin planilla generada (caso edge: cobrador sin planilla pero con
 * cuotas asignadas, o cuota no incluida en el filtro de la planilla).
 *
 * @param {string} collectorId
 * @param {string} installmentId
 * @param {'VISITED'|'NO_PAYMENT'|'NOT_FOUND'|'PAID'} newStatus
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<boolean>} true si actualizó la fila de planilla.
 */
const updateManagementStatusForActiveTodaySheet = async (
  collectorId,
  installmentId,
  newStatus,
  db = pool,
) => {
  if (!collectorId || !installmentId || !newStatus) return false;
  const r = await db.query(
    `UPDATE collection_sheet_details csd
     SET management_status = $3
     FROM collection_sheets cs
     WHERE csd.sheet_id = cs.id
       AND cs.collector_id = $1
       AND csd.installment_id = $2
       AND cs.status = 'ACTIVE'
       AND cs.sheet_date = CURRENT_DATE`,
    [collectorId, installmentId, newStatus],
  );
  return r.rowCount > 0;
};

/**
 * Recalcula management_status desde las gestiones VIVAS del día, en lugar de
 * fijarlo a un valor. Se usa al ANULAR un intento: si el cobrador anuló su
 * única gestión, la planilla debe volver a 'PENDING' para que pueda gestionar
 * de nuevo (el intento anulado queda en el log para auditoría, pero ya no
 * cuenta como gestión vigente).
 *
 * Derivación (precedencia cobro > intento):
 *   1. Pago vivo del día (PENDING/APPROVED, no reversión) → 'PAID' si la cuota
 *      quedó saldada, sino 'VISITED'.
 *   2. Último intento vivo del día (voided_at IS NULL) → su attempt_type.
 *   3. Nada vivo → 'PENDING'.
 *
 * @param {string} collectorId
 * @param {string} installmentId
 * @param {import('pg').Pool|import('pg').PoolClient} [db=pool]
 * @returns {Promise<boolean>} true si actualizó la fila de planilla.
 */
const recalcManagementStatusForActiveTodaySheet = async (
  collectorId,
  installmentId,
  db = pool,
) => {
  if (!collectorId || !installmentId) return false;
  const r = await db.query(
    `SELECT
       CASE
         WHEN EXISTS (
           SELECT 1 FROM payments p
           WHERE p.installment_id = $2
             AND p.collector_id = $1
             AND p.is_reversal = FALSE
             AND p.status IN ('PENDING','APPROVED')
             AND p.created_at::date = CURRENT_DATE
         ) THEN (
           CASE WHEN (SELECT status FROM installments WHERE id = $2) = 'PAID'
                THEN 'PAID' ELSE 'VISITED' END
         )
         ELSE COALESCE((
           SELECT a.attempt_type
           FROM collection_attempts a
           WHERE a.installment_id = $2
             AND a.collector_id = $1
             AND a.voided_at IS NULL
             AND a.created_at::date = CURRENT_DATE
             -- SCHEDULED_VISIT (agenda administrativa) no es una gestión de
             -- campo: no deriva management_status (que además no admite ese
             -- valor en su CHECK). Solo cuentan NO_PAYMENT/NOT_FOUND.
             AND a.attempt_type <> 'SCHEDULED_VISIT'
           ORDER BY a.created_at DESC
           LIMIT 1
         ), 'PENDING')
       END AS status`,
    [collectorId, installmentId],
  );
  const newStatus = r.rows[0].status;
  return updateManagementStatusForActiveTodaySheet(
    collectorId,
    installmentId,
    newStatus,
    db,
  );
};

module.exports = {
  findInstallmentsForSheet,
  create,
  createDetails,
  markSheetAsRegenerated,
  closeSheet,
  cancelSheet,
  markAsSent,
  findAll,
  findActiveByCollectorAndDate,
  findById,
  findUnassignedCustomersWithPending,
  updateManagementStatusForActiveTodaySheet,
  recalcManagementStatusForActiveTodaySheet,
};
