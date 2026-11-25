// Issues #52 y #53 — guardas del setup de base: numeración única de
// migraciones y semillas bloqueadas en producción.

const fs = require("fs");
const path = require("path");

jest.mock("pg", () => ({ Pool: jest.fn() }));

const {
  findNewDuplicatePrefixes,
} = require("../../src/scripts/migration.run");
const { assertSeedAllowed } = require("../../src/seeds/guard");

describe("findNewDuplicatePrefixes", () => {
  test("las migraciones actuales no tienen prefijos repetidos nuevos", () => {
    const dir = path.join(__dirname, "../../src/config/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(findNewDuplicatePrefixes(files)).toEqual([]);
  });

  test("detecta un prefijo repetido nuevo e ignora los legacy", () => {
    expect(
      findNewDuplicatePrefixes([
        "033_a.sql",
        "033_b.sql",
        "052_x.sql",
        "052_y.sql",
      ]),
    ).toEqual(["052"]);
  });
});

describe("assertSeedAllowed", () => {
  test("aborta con NODE_ENV=production", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(
      /NODE_ENV=production/,
    );
  });

  test("permite development y test", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: "test" })).not.toThrow();
  });
});
