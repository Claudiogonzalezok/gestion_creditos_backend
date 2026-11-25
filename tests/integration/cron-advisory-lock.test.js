// Integración — exclusión mutua de cron jobs entre procesos (issue #36).
// Cada corrida toma pg_try_advisory_lock por job: si otro proceso ya lo está
// ejecutando, la corrida se saltea (no se ejecuta dos veces la misma mora).

const { pool, setupTestSuite } = require("./helpers/db");
const { withAdvisoryLock } = require("../../src/utils/advisoryLock");
const { markOverdueAndApplyPenalty } = require("../../src/jobs/overdueInstallments.job");

setupTestSuite();

const originalWarn = console.warn;
beforeAll(() => { console.warn = jest.fn(); });
afterAll(() => { console.warn = originalWarn; });

/** Crea una promesa con resolve expuesto para controlar el orden. */
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const cronRuns = async (job) =>
  Number((await pool.query("SELECT COUNT(*) FROM cron_execution_log WHERE job_name = $1", [job])).rows[0].count);

describe("withAdvisoryLock", () => {
  it("dos ejecuciones simultáneas del mismo job: solo una corre, la otra se saltea", async () => {
    const gate = deferred();
    const started = deferred();
    const fnA = jest.fn(async () => { started.resolve(); await gate.promise; return "A"; });
    const fnB = jest.fn(async () => "B");

    const runA = withAdvisoryLock("test-job", fnA);
    await started.promise;
    const resultB = await withAdvisoryLock("test-job", fnB);
    gate.resolve();

    expect(await runA).toEqual({ acquired: true, result: "A" });
    expect(resultB).toEqual({ acquired: false });
    expect(fnB).not.toHaveBeenCalled();

    // Al terminar A el lock se libera y una nueva corrida sí ejecuta.
    expect(await withAdvisoryLock("test-job", fnB)).toEqual({ acquired: true, result: "B" });
  });

  it("jobs distintos no se bloquean entre sí", async () => {
    const gate = deferred();
    const started = deferred();
    const runA = withAdvisoryLock("job-a", async () => { started.resolve(); await gate.promise; });
    await started.promise;
    const resultB = await withAdvisoryLock("job-b", async () => "B");
    gate.resolve();
    await runA;
    expect(resultB).toEqual({ acquired: true, result: "B" });
  });

  it("libera el lock aunque el job lance", async () => {
    await expect(withAdvisoryLock("job-err", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await withAdvisoryLock("job-err", async () => 1)).toEqual({ acquired: true, result: 1 });
  });
});

describe("runWithLogging + lock (job real)", () => {
  it("si otro proceso tiene el lock de overdueInstallments, la corrida se saltea sin registrar ejecución", async () => {
    const gate = deferred();
    const started = deferred();
    const holder = withAdvisoryLock("overdueInstallments", async () => { started.resolve(); await gate.promise; });
    await started.promise;

    const before = await cronRuns("overdueInstallments");
    const result = await markOverdueAndApplyPenalty();
    gate.resolve();
    await holder;

    expect(result).toEqual({ skipped: true });
    expect(await cronRuns("overdueInstallments")).toBe(before);

    // Sin competencia, la corrida normal se ejecuta y queda registrada.
    await markOverdueAndApplyPenalty();
    expect(await cronRuns("overdueInstallments")).toBe(before + 1);
  });
});
