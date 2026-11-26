// P32 (#39): montos exactos en centavos.
const {
  toCents,
  round2,
  addMoney,
  subtractMoney,
  splitMoney,
} = require("../../src/utils/money");

describe("utils/money", () => {
  it("round2(1.005) redondea a 1.01 (no 1.00 por flotante)", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2("1.005")).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
  });

  it("0.1 + 0.2 suma exactamente 0.3", () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(subtractMoney(0.3, 0.1)).toBe(0.2);
  });

  it("toCents tolera strings de NUMERIC y valores no numéricos", () => {
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents(null)).toBe(0);
    expect(toCents("abc")).toBe(0);
  });

  it.each([
    [1000, 3],
    [100, 7],
    [0.1, 3],
    [1.005, 2],
    [999999.99, 12],
  ])("splitMoney(%p, %p) suma exactamente el total", (total, count) => {
    const parts = splitMoney(total, count);
    expect(parts).toHaveLength(count);
    const sumCents = parts.reduce((a, p) => a + toCents(p), 0);
    expect(sumCents).toBe(toCents(total));
    parts.forEach((p) => expect(toCents(p) / 100).toBe(p));
  });

  it("splitMoney con count inválido devuelve []", () => {
    expect(splitMoney(100, 0)).toEqual([]);
  });
});

describe("parseMoneyInput", () => {
  const { parseMoneyInput } = require("../../src/utils/money");

  it("vacío/undefined vale 0 y redondea a centavos", () => {
    expect(parseMoneyInput(undefined, "x")).toBe(0);
    expect(parseMoneyInput("", "x")).toBe(0);
    expect(parseMoneyInput("10.005", "x")).toBe(10.01);
  });

  it("valor no numérico lanza 400 en vez de convertirse en 0", () => {
    expect(() => parseMoneyInput("abc", "Los cargos adicionales")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseMoneyInput("Infinity", "x")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
