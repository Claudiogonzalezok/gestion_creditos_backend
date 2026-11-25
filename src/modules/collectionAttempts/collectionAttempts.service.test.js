// Gestión Administrativa de Cuotas — visita programada (SCHEDULED_VISIT).
// Cubre el path nuevo del admin sin tocar el flujo del cobrador
// (NO_PAYMENT/NOT_FOUND), que debe seguir disparando el hook de planilla.

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("./collectionAttempts.queries", () => ({ create: jest.fn() }));
jest.mock("../collections/collections.queries", () => ({
  updateManagementStatusForActiveTodaySheet: jest.fn(),
  recalcManagementStatusForActiveTodaySheet: jest.fn(),
}));

const pool = require("../../config/db");
const queries = require("./collectionAttempts.queries");
const collectionsQueries = require("../collections/collections.queries");
const service = require("./collectionAttempts.service");

const ADMIN = { id: "admin-1", role: "ADMIN" };
const COLLECTOR = { id: "col-1", role: "COLLECTOR" };
const SELLER = { id: "sel-1", role: "SELLER" };
const SELLER_COLLECTOR = { id: "selcol-1", role: "SELLER_COLLECTOR" };

/** Configura el SELECT de la cuota que hace el service al inicio de create(). */
const mockInstallment = (overrides = {}) => {
  pool.query.mockResolvedValueOnce({
    rows: [
      {
        id: "inst-1",
        installment_status: "OVERDUE",
        credit_id: "c1",
        credit_status: "ACTIVE",
        assigned_collector_id: "col-1",
        today_date: "2026-06-23",
        tomorrow_date: "2026-06-24",
        ...overrides,
      },
    ],
  });
};

describe("collectionAttempts.create — SCHEDULED_VISIT (gestión admin)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rechaza con 403 si el rol es COLLECTOR (cobrador puro no programa)", async () => {
    await expect(
      service.create(
        { installment_id: "inst-1", attempt_type: "SCHEDULED_VISIT" },
        COLLECTOR,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rechaza con 409 si la cuota está PAID", async () => {
    mockInstallment({ installment_status: "PAID" });
    await expect(
      service.create(
        {
          installment_id: "inst-1",
          attempt_type: "SCHEDULED_VISIT",
          next_visit_date: "2026-06-30",
          notes: "Cliente llamó",
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechaza con 422 si falta la fecha de visita", async () => {
    mockInstallment();
    await expect(
      service.create(
        {
          installment_id: "inst-1",
          attempt_type: "SCHEDULED_VISIT",
          notes: "Cliente llamó",
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rechaza con 422 si la fecha de visita es anterior a hoy", async () => {
    mockInstallment();
    await expect(
      service.create(
        {
          installment_id: "inst-1",
          attempt_type: "SCHEDULED_VISIT",
          next_visit_date: "2026-06-01",
          notes: "Cliente llamó",
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rechaza con 422 si falta la observación", async () => {
    mockInstallment();
    await expect(
      service.create(
        {
          installment_id: "inst-1",
          attempt_type: "SCHEDULED_VISIT",
          next_visit_date: "2026-06-30",
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("imputa al cobrador asignado, registra created_by=admin y NO toca el management_status del día", async () => {
    mockInstallment({ assigned_collector_id: "col-1" });
    queries.create.mockResolvedValue({ id: "att-1" });

    const res = await service.create(
      {
        installment_id: "inst-1",
        attempt_type: "SCHEDULED_VISIT",
        next_visit_date: "2026-06-30",
        notes: "Cliente pasa a pagar el lunes",
      },
      ADMIN,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        installmentId: "inst-1",
        collectorId: "col-1", // cobrador asignado, no el admin
        createdBy: "admin-1",
        attemptType: "SCHEDULED_VISIT",
        nextVisitDate: "2026-06-30",
        notes: "Cliente pasa a pagar el lunes",
      }),
    );
    // La visita futura NO es gestión del día → no debe tocar la planilla.
    expect(
      collectionsQueries.updateManagementStatusForActiveTodaySheet,
    ).not.toHaveBeenCalled();
    expect(res).toEqual({ id: "att-1" });
  });

  it("si el cliente no tiene cobrador asignado, la visita queda a nombre del admin", async () => {
    mockInstallment({ assigned_collector_id: null });
    queries.create.mockResolvedValue({ id: "att-2" });

    await service.create(
      {
        installment_id: "inst-1",
        attempt_type: "SCHEDULED_VISIT",
        next_visit_date: "2026-06-30",
        notes: "Sin cobrador asignado",
      },
      ADMIN,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({ collectorId: "admin-1", createdBy: "admin-1" }),
    );
  });

  it("un VENDEDOR puede programar: se imputa al cobrador asignado y created_by=vendedor", async () => {
    mockInstallment({ assigned_collector_id: "col-1" });
    queries.create.mockResolvedValue({ id: "att-5" });

    await service.create(
      {
        installment_id: "inst-1",
        attempt_type: "SCHEDULED_VISIT",
        next_visit_date: "2026-06-30",
        notes: "El cliente me avisó en la calle",
      },
      SELLER,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({ collectorId: "col-1", createdBy: "sel-1" }),
    );
    expect(
      collectionsQueries.updateManagementStatusForActiveTodaySheet,
    ).not.toHaveBeenCalled();
  });

  it("un MIXTO puede programar sobre un cliente que NO es de su cartera (exención de cartera)", async () => {
    mockInstallment({ assigned_collector_id: "col-9" });
    queries.create.mockResolvedValue({ id: "att-6" });

    await service.create(
      {
        installment_id: "inst-1",
        attempt_type: "SCHEDULED_VISIT",
        next_visit_date: "2026-06-30",
        notes: "Cliente de otra cartera me avisó",
      },
      SELLER_COLLECTOR,
    );

    // No lanza 403 por cartera; la visita se imputa al cobrador asignado real.
    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({ collectorId: "col-9", createdBy: "selcol-1" }),
    );
  });
});

describe("collectionAttempts.create — compat flujo cobrador (NO_PAYMENT)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("NO_PAYMENT sigue disparando el hook de management_status del día", async () => {
    mockInstallment({ assigned_collector_id: "col-1" });
    queries.create.mockResolvedValue({ id: "att-3" });

    await service.create(
      {
        installment_id: "inst-1",
        attempt_type: "NO_PAYMENT",
        reason: "No tenía el dinero",
        next_visit_date: "2026-06-30",
      },
      COLLECTOR,
    );

    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({ collectorId: "col-1", attemptType: "NO_PAYMENT" }),
    );
    expect(
      collectionsQueries.updateManagementStatusForActiveTodaySheet,
    ).toHaveBeenCalledWith("col-1", "inst-1", "NO_PAYMENT");
  });

  it("NOT_FOUND agenda automáticamente la próxima visita para el día siguiente", async () => {
    mockInstallment({ assigned_collector_id: "col-1" });
    queries.create.mockResolvedValue({ id: "att-4" });

    await service.create(
      { installment_id: "inst-1", attempt_type: "NOT_FOUND" },
      COLLECTOR,
    );

    // La fecha se fija automáticamente al día siguiente (tomorrow_date), sin que
    // el cobrador la ingrese.
    expect(queries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptType: "NOT_FOUND",
        nextVisitDate: "2026-06-24",
      }),
    );
    // Sigue reflejando la gestión del día en la planilla.
    expect(
      collectionsQueries.updateManagementStatusForActiveTodaySheet,
    ).toHaveBeenCalledWith("col-1", "inst-1", "NOT_FOUND");
  });
});
