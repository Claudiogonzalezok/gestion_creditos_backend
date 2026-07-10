const {
  addFrequencyPeriods,
  adjustDueDatesWithBusinessDayRule,
  getDueDates,
  getDueDatesFromFirstPayment,
  getInstallmentAmount,
  getTotalToReturn,
  getProductInstallmentContribution,
} = require("./creditCalculator");

const toKey = (date) => date.toISOString().slice(0, 10);

describe("creditCalculator", () => {
  it("avanza períodos correctamente según frecuencia", () => {
    const base = new Date(2026, 0, 10);

    expect(toKey(addFrequencyPeriods(base, "DAILY", 1))).toBe("2026-01-11");
    expect(toKey(addFrequencyPeriods(base, "WEEKLY", 1))).toBe("2026-01-17");
    expect(toKey(addFrequencyPeriods(base, "BIWEEKLY", 1))).toBe("2026-01-24");
    expect(toKey(addFrequencyPeriods(base, "MONTHLY", 1))).toBe("2026-02-10");
  });

  it("DAILY avanza 1 día corrido por período (cruza fin de mes)", () => {
    const base = new Date(2026, 0, 30);
    expect(toKey(addFrequencyPeriods(base, "DAILY", 1))).toBe("2026-01-31");
    expect(toKey(addFrequencyPeriods(base, "DAILY", 2))).toBe("2026-02-01");
  });

  it("lanza error ante una frecuencia no soportada (nunca cae en mensual)", () => {
    expect(() => addFrequencyPeriods(new Date(2026, 0, 10), "YEARLY", 1)).toThrow(
      /no soportada/,
    );
  });

  it("genera vencimientos diarios consecutivos desde la primera cuota (días corridos)", () => {
    const result = getDueDatesFromFirstPayment("2026-08-10", 5, "DAILY").map(
      toKey,
    );
    expect(result).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
  });

  it("genera vencimientos desde aprobación moviendo la primera cuota un período después", () => {
    const result = getDueDates(new Date(2026, 0, 10), 3, "WEEKLY").map(toKey);
    expect(result).toEqual(["2026-01-17", "2026-01-24", "2026-01-31"]);
  });

  it("usa la primera fecha explícita como ancla y vence el mismo día cada mes", () => {
    const result = getDueDatesFromFirstPayment("2026-03-15", 3, "MONTHLY").map(
      toKey,
    );
    expect(result).toEqual(["2026-03-15", "2026-04-15", "2026-05-15"]);
  });

  it("vence el mismo día de cada mes calendario (ancla día 24)", () => {
    const result = getDueDatesFromFirstPayment("2026-01-24", 4, "MONTHLY").map(
      toKey,
    );

    expect(result).toEqual([
      "2026-01-24",
      "2026-02-24",
      "2026-03-24",
      "2026-04-24",
    ]);
  });

  it("recorta al último día del mes cuando el ancla (31) no existe en el mes destino", () => {
    const result = getDueDatesFromFirstPayment("2026-01-31", 4, "MONTHLY").map(
      toKey,
    );

    expect(result).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("aplica la regla de día hábil preservando el orden de vencimientos", () => {
    const moveFn = jest
      .fn()
      .mockImplementation(
        (date) => new Date(date.getTime() + 24 * 60 * 60 * 1000),
      );

    const result = adjustDueDatesWithBusinessDayRule(
      [new Date(2026, 0, 10), new Date(2026, 0, 17)],
      moveFn,
    ).map(toKey);

    expect(moveFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual(["2026-01-11", "2026-01-18"]);
  });

  it("mantiene consistencia entre monto por cuota, total y contribución por producto", () => {
    const installment = getInstallmentAmount(100000, 0.1, 5);
    expect(installment).toBe(22000);
    expect(getTotalToReturn(100000, 0.1, 5)).toBe(110000);
    expect(getProductInstallmentContribution(100000, 0.1, 5)).toBe(22000);
  });
});
