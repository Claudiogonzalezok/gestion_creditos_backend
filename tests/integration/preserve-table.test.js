// Verifica los helpers que restauran tablas de referencia entre suites.
const {
  pool,
  setupTestSuite,
  preserveTable,
  snapshotTable,
  restoreTable,
} = require("./helpers/db");

preserveTable("interest_rates");
setupTestSuite();

const countRates = async () =>
  (await pool.query("SELECT count(*)::int AS n FROM interest_rates")).rows[0].n;

describe("snapshotTable / restoreTable", () => {
  it("restaura las filas originales después de modificarlas", async () => {
    const snapshot = await snapshotTable("interest_rates");
    await pool.query("DELETE FROM interest_rates");
    expect(await countRates()).toBe(0);

    await restoreTable("interest_rates", snapshot);

    expect(await countRates()).toBe(snapshot.length);
    const restored = await snapshotTable("interest_rates");
    const byId = (a, b) => a.id - b.id;
    expect(restored.sort(byId)).toEqual([...snapshot].sort(byId));
  });

  it("si una fila falla, no deja la tabla vacía ni a medias", async () => {
    const before = await countRates();
    const snapshot = await snapshotTable("interest_rates");
    // Fila inválida primero: el INSERT falla justo después del DELETE, antes
    // de reinsertar nada. Sin transacción la tabla quedaría vacía.
    const broken = [{ id: "no-es-un-numero" }, ...snapshot];

    await expect(restoreTable("interest_rates", broken)).rejects.toThrow();

    expect(await countRates()).toBe(before);
  });
});
