// Bloque V4-A — helpers V4 de caja activa por jornada
//
// Cubre los dos lookups nuevos introducidos en Fase V4.1:
//   · findActiveSessionByBusinessDay(businessDayId)
//   · lockActiveSessionByBusinessDay(client, businessDayId)
//
// El invariante "una sola caja por jornada, siempre" está enforced a nivel
// DB desde la migración 037 (índice único total sobre business_day_id, sin
// filtro de status). No hay multi-turno: una vez que una jornada tuvo una
// caja (en cualquier status), no se puede abrir otra para esa jornada.

const { pool, setupTestSuite } = require("./helpers/db");
const { createUserFixture } = require("./helpers/fixtures");
const cashSessionsQueries = require("../../src/modules/cashSessions/cashSessions.queries");
const cashSessionsService = require("../../src/modules/cashSessions/cashSessions.service");
const businessDaysService = require("../../src/modules/businessDays/businessDays.service");
const { withTransaction } = require("../../src/utils/transaction");

setupTestSuite();

const asUser = (u) => ({ id: u.id, role: u.role });

describe("V4-A — findActiveSessionByBusinessDay / lockActiveSessionByBusinessDay", () => {
  it("findActiveSessionByBusinessDay devuelve la caja OPEN única de la jornada", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 1000 },
      asUser(admin),
    );

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      session.business_day_id,
    );
    expect(active).not.toBeNull();
    expect(active.id).toBe(session.id);
    expect(active.status).toBe("OPEN");
    expect(active.opening_amount).toBe(1000);
  });

  it("findActiveSessionByBusinessDay devuelve null cuando no hay caja OPEN", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );
    await cashSessionsService.close(
      session.id,
      {
        declared: [{ payment_method: "CASH", declared_amount: 0 }],
      },
      asUser(admin),
    );

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      session.business_day_id,
    );
    expect(active).toBeNull();
  });

  it("findActiveSessionByBusinessDay NO devuelve cajas en PENDING_RECONCILIATION", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );
    await cashSessionsService.markPending(
      session.id,
      { reason: "olvido" },
      asUser(admin),
    );

    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      session.business_day_id,
    );
    expect(active).toBeNull();
  });

  it("findActiveSessionByBusinessDay para business_day inexistente devuelve null", async () => {
    const active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(active).toBeNull();
  });

  it("lockActiveSessionByBusinessDay dentro de tx devuelve la caja OPEN bajo lock", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 500 },
      asUser(admin),
    );

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client,
        session.business_day_id,
      );
      expect(locked).not.toBeNull();
      expect(locked.id).toBe(session.id);
    });
  });

  it("lockActiveSessionByBusinessDay devuelve null cuando no hay caja activa", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });
    const session = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );
    await cashSessionsService.close(
      session.id,
      {
        declared: [{ payment_method: "CASH", declared_amount: 0 }],
      },
      asUser(admin),
    );

    await withTransaction(async (client) => {
      const locked = await cashSessionsQueries.lockActiveSessionByBusinessDay(
        client,
        session.business_day_id,
      );
      expect(locked).toBeNull();
    });
  });

  it("rechaza abrir una segunda caja en la jornada aunque la primera ya esté CLOSED (no hay multi-turno)", async () => {
    const admin = await createUserFixture({ role: "ADMIN" });

    // Turno único: abrir y cerrar.
    const s1 = await cashSessionsService.open(
      { opening_amount: 0 },
      asUser(admin),
    );
    await cashSessionsService.close(
      s1.id,
      {
        declared: [{ payment_method: "CASH", declared_amount: 0 }],
      },
      asUser(admin),
    );

    // En este punto findActive debe devolver null (no hay OPEN) — pero la
    // jornada SIGUE teniendo una caja (CLOSED), así que abrir otra debe fallar.
    let active = await cashSessionsQueries.findActiveSessionByBusinessDay(
      s1.business_day_id,
    );
    expect(active).toBeNull();

    // Aunque alguien revierta manualmente la jornada a OPEN, el invariante
    // "una sola caja por jornada, siempre" bloquea la apertura de una segunda.
    await pool.query(
      `UPDATE business_days SET status='OPEN', ready_to_close_at=NULL WHERE id=$1`,
      [s1.business_day_id],
    );

    await expect(
      cashSessionsService.open({ opening_amount: 200 }, asUser(admin)),
    ).rejects.toMatchObject({
      status: 409,
      code: "ACTIVE_SESSION_IN_BUSINESS_DAY",
    });

    // Sigue existiendo una sola caja para esa jornada: la original, CLOSED.
    const any = await cashSessionsQueries.findAnySessionByBusinessDay(
      s1.business_day_id,
    );
    expect(any.id).toBe(s1.id);
    expect(any.status).toBe("CLOSED");
  });
});
