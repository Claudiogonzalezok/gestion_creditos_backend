const queries = require("./holidays.queries");
const { withTransaction } = require("../../utils/transaction");
const {
  toDateKey,
  moveToNextBusinessDay,
  getActiveHolidayKeysInRange,
} = require("../../utils/businessDay");

/**
 * Lista feriados con filtros opcionales.
 * @param {object} filters - Filtros de búsqueda.
 * @returns {Promise<object[]>} Feriados encontrados.
 */
const getAll = async (filters) => queries.findAll(filters);

/**
 * Obtiene un feriado por su identificador.
 * @param {string} id - ID del feriado.
 * @returns {Promise<object>} Feriado recuperado.
 */
const getById = async (id) => {
  const holiday = await queries.findById(id);
  if (!holiday) throw { status: 404, message: "Feriado no encontrado." };
  return holiday;
};

/**
 * Crea un feriado y, opcionalmente, recalcula cuotas futuras con vencimiento exacto ese día.
 * @param {object} data - Datos de creación del feriado.
 * @returns {Promise<object>} Resultado con feriado creado y resumen de recálculo.
 */
const create = async (data) => {
  const {
    date,
    name,
    type = "EXTRAORDINARY",
    affects_due_dates = true,
    active = true,
    repeats_annually = type !== "EXTRAORDINARY",
    recalculateFutureInstallments = false,
  } = data;

  return withTransaction(async (client) => {
    const created = await queries.create(client, {
      date,
      name,
        type,
        affects_due_dates,
        active,
        repeats_annually,
      });

    const shouldRecalculate =
      recalculateFutureInstallments === true &&
      created.type === "EXTRAORDINARY" &&
      created.affects_due_dates === true &&
      created.active === true;

    if (!shouldRecalculate) {
      return {
        holiday: created,
        recalculated_installments: 0,
        updated_installments: [],
      };
    }

    const key = toDateKey(created.date);
    const plus15 = new Date(created.date);
    plus15.setDate(plus15.getDate() + 15);
    const holidayKeys = await getActiveHolidayKeysInRange(key, plus15);
    holidayKeys.add(key);
    const nextBusinessDay = moveToNextBusinessDay(
      new Date(created.date),
      holidayKeys,
    );

    const affected = await queries.recalculateFutureInstallmentsByExactDate(
      client,
      {
        targetDate: key,
        newDueDate: toDateKey(nextBusinessDay),
      },
    );

    return {
      holiday: created,
      recalculated_installments: affected.length,
      updated_installments: affected,
    };
  });
};

/**
 * Actualiza metadatos de un feriado existente.
 * @param {string} id - ID del feriado.
 * @param {object} data - Campos editables.
 * @returns {Promise<object>} Feriado actualizado.
 */
const update = async (id, data) => {
  const current = await queries.findById(id);
  if (!current) throw { status: 404, message: "Feriado no encontrado." };
  return queries.update(id, {
    ...data,
    repeats_annually:
      data.repeats_annually ??
      (data.type === "EXTRAORDINARY" ? false : current.repeats_annually),
  });
};

/**
 * Convierte una fecha a clave local YYYY-MM-DD preservando día/mes.
 * @param {Date} date - Fecha a serializar.
 * @returns {string} Clave de fecha.
 */
const toLocalDateKey = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * Calcula una fecha en el año destino preservando mes y día, o null si no existe.
 * @param {string} sourceDate - Fecha origen en formato YYYY-MM-DD.
 * @param {number} targetYear - Año destino.
 * @returns {string|null} Fecha destino válida o null cuando es imposible.
 */
const buildTargetDate = (sourceDate, targetYear) => {
  const [rawYear, rawMonth, rawDay] = sourceDate.split("-").map(Number);
  const candidate = new Date(targetYear, rawMonth - 1, rawDay);
  if (
    !Number.isFinite(rawYear) ||
    !Number.isFinite(rawMonth) ||
    !Number.isFinite(rawDay) ||
    candidate.getFullYear() !== targetYear ||
    candidate.getMonth() !== rawMonth - 1 ||
    candidate.getDate() !== rawDay
  ) {
    return null;
  }
  return toLocalDateKey(candidate);
};

/**
 * Construye el plan de duplicación anual sin persistir cambios.
 * @param {number} sourceYear - Año origen a duplicar.
 * @returns {Promise<object>} Vista previa con candidatos, conflictos y omisiones.
 */
const buildDuplicateYearPlan = async (sourceYear) => {
  const targetYear = sourceYear + 1;
  const activeHolidays = await queries.findActiveByYear(sourceYear);
  const existing = await queries.findExistingDateTypeByYear(targetYear);

  const existingKeys = new Set(
    existing.map((row) => `${toDateKey(row.date)}|${row.type}`),
  );
  const pendingKeys = new Set();
  const candidates = [];
  const skipped = [];

  activeHolidays.forEach((holiday) => {
    const sourceDate = toDateKey(holiday.date);

    if (!holiday.repeats_annually) {
      skipped.push({
        sourceDate,
        targetDate: null,
        type: holiday.type,
        name: holiday.name,
        repeats_annually: holiday.repeats_annually,
        reason: "not_recurring_annual",
      });
      return;
    }

    const targetDate = buildTargetDate(sourceDate, targetYear);
    if (!targetDate) {
      skipped.push({
        sourceDate,
        targetDate: null,
        type: holiday.type,
        name: holiday.name,
        repeats_annually: holiday.repeats_annually,
        reason: "invalid_target_date",
      });
      return;
    }

    const key = `${targetDate}|${holiday.type}`;
    if (existingKeys.has(key) || pendingKeys.has(key)) {
      skipped.push({
        sourceDate,
        targetDate,
        type: holiday.type,
        name: holiday.name,
        repeats_annually: holiday.repeats_annually,
        reason: "duplicate_in_target",
      });
      return;
    }

    pendingKeys.add(key);
    candidates.push({
      date: targetDate,
      name: holiday.name,
      type: holiday.type,
      affects_due_dates: holiday.affects_due_dates,
      active: holiday.active,
      repeats_annually: holiday.repeats_annually,
      sourceDate,
    });
  });

  return {
    sourceYear,
    targetYear,
    eligibleCount: activeHolidays.length,
    toCreateCount: candidates.length,
    skippedCount: skipped.length,
    conflictsCount: skipped.filter((item) => item.reason === "duplicate_in_target")
      .length,
    invalidDatesCount: skipped.filter(
      (item) => item.reason === "invalid_target_date",
    ).length,
    nonRecurringCount: skipped.filter(
      (item) => item.reason === "not_recurring_annual",
    ).length,
    toCreate: candidates.map((item) => ({
      sourceDate: item.sourceDate,
      targetDate: item.date,
      type: item.type,
      name: item.name,
      repeats_annually: item.repeats_annually,
    })),
    skipped,
    _itemsToCreate: candidates,
  };
};

/**
 * Obtiene una vista previa de la duplicación anual sin crear registros.
 * @param {number} sourceYear - Año origen a evaluar.
 * @returns {Promise<object>} Resumen de lo que se duplicará y lo que se omitirá.
 */
const previewDuplicateYear = async (sourceYear) => {
  const plan = await buildDuplicateYearPlan(sourceYear);
  return {
    sourceYear: plan.sourceYear,
    targetYear: plan.targetYear,
    eligibleCount: plan.eligibleCount,
    toCreateCount: plan.toCreateCount,
    skippedCount: plan.skippedCount,
    conflictsCount: plan.conflictsCount,
    invalidDatesCount: plan.invalidDatesCount,
    nonRecurringCount: plan.nonRecurringCount,
    toCreate: plan.toCreate,
    skipped: plan.skipped,
  };
};

/**
 * Duplica feriados anuales repetibles del año origen al siguiente.
 * @param {number} sourceYear - Año origen a duplicar.
 * @returns {Promise<object>} Resumen de creados y omitidos.
 */
const duplicateYear = async (sourceYear) => {
  const plan = await buildDuplicateYearPlan(sourceYear);
  const toCreate = plan._itemsToCreate;

  const createdRows = await withTransaction(async (client) =>
    queries.bulkCreate(
      client,
      toCreate.map(({ date, name, type, affects_due_dates, active, repeats_annually }) => ({
        date,
        name,
        type,
        affects_due_dates,
        active,
        repeats_annually,
      })),
    ),
  );

  const createdSet = new Set(
    createdRows.map((row) => `${toDateKey(row.date)}|${row.type}`),
  );
  const createdItems = toCreate
    .filter((item) => createdSet.has(`${item.date}|${item.type}`))
    .map((item) => ({
      sourceDate: item.sourceDate,
      targetDate: item.date,
      type: item.type,
      name: item.name,
      repeats_annually: item.repeats_annually,
    }));

  const skipped = [...plan.skipped];
  toCreate
    .filter((item) => !createdSet.has(`${item.date}|${item.type}`))
    .forEach((item) => {
      skipped.push({
        sourceDate: item.sourceDate,
        targetDate: item.date,
        type: item.type,
        name: item.name,
        repeats_annually: item.repeats_annually,
        reason: "conflict_on_insert",
      });
    });

  return {
    sourceYear: plan.sourceYear,
    targetYear: plan.targetYear,
    eligibleCount: plan.eligibleCount,
    createdCount: createdItems.length,
    skippedCount: skipped.length,
    conflictsCount: skipped.filter(
      (item) =>
        item.reason === "duplicate_in_target" ||
        item.reason === "conflict_on_insert",
    ).length,
    invalidDatesCount: skipped.filter(
      (item) => item.reason === "invalid_target_date",
    ).length,
    nonRecurringCount: skipped.filter(
      (item) => item.reason === "not_recurring_annual",
    ).length,
    created: createdItems,
    skipped,
  };
};

module.exports = { getAll, getById, create, update, previewDuplicateYear, duplicateYear };
