const cache = require("./cache");

describe("cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cache.clearAll();
  });

  describe("get / set", () => {
    it("devuelve undefined para una clave inexistente (miss)", () => {
      expect(cache.get("no-existe")).toBeUndefined();
    });

    it("devuelve el valor guardado", () => {
      cache.set("k", "valor");
      expect(cache.get("k")).toBe("valor");
    });

    it("almacena null como valor legítimo y lo distingue del miss", () => {
      cache.set("nulo", null);
      expect(cache.get("nulo")).toBeNull();
    });

    it("almacena objetos y arrays sin modificarlos", () => {
      const obj = { a: 1, b: [2, 3] };
      cache.set("obj", obj);
      expect(cache.get("obj")).toEqual({ a: 1, b: [2, 3] });
    });

    it("devuelve undefined y elimina la entrada cuando el TTL expiró (miss)", () => {
      jest.useFakeTimers();
      cache.set("exp", "valor", 1000);
      jest.advanceTimersByTime(1001);
      expect(cache.get("exp")).toBeUndefined();
      jest.useRealTimers();
    });

    it("devuelve el valor si el TTL no expiró", () => {
      jest.useFakeTimers();
      cache.set("vivo", "valor", 1000);
      jest.advanceTimersByTime(999);
      expect(cache.get("vivo")).toBe("valor");
      jest.useRealTimers();
    });
  });

  describe("invalidate", () => {
    it("elimina la clave especificada", () => {
      cache.set("a", 1);
      cache.invalidate("a");
      expect(cache.get("a")).toBeUndefined();
    });

    it("no lanza si la clave no existe", () => {
      expect(() => cache.invalidate("no-existe")).not.toThrow();
    });
  });

  describe("invalidateByPrefix", () => {
    it("elimina solo las claves que comienzan con el prefijo", () => {
      cache.set("ns:a", 1);
      cache.set("ns:b", 2);
      cache.set("otro:c", 3);
      cache.invalidateByPrefix("ns:");
      expect(cache.get("ns:a")).toBeUndefined();
      expect(cache.get("ns:b")).toBeUndefined();
      expect(cache.get("otro:c")).toBe(3);
    });

    it("no lanza si no hay claves con ese prefijo", () => {
      expect(() => cache.invalidateByPrefix("sin-match:")).not.toThrow();
    });
  });

  describe("clearAll", () => {
    it("elimina todas las entradas", () => {
      cache.set("x", 1);
      cache.set("y", 2);
      cache.clearAll();
      expect(cache.get("x")).toBeUndefined();
      expect(cache.get("y")).toBeUndefined();
    });
  });
});
