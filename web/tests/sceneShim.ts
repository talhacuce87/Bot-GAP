// Sahneyi Node'da kurmak için en küçük DOM: tabelaların tuvali her çizim çağrısını kabul eder (çizim sonucu
// burada önemsiz; yalnızca nesnelerin nereye konduğuna bakılır).
const ctx2d = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === "measureText" ? () => ({ width: 10 })
      : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} })
      : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {},
    set: () => true,
  },
);
const fakeCanvas = () => ({ width: 1, height: 1, style: {}, getContext: () => ctx2d, addEventListener() {}, toDataURL: () => "" });
const fakeEl = () => ({ style: {}, append() {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, toggle() {} } });
Object.assign(globalThis, {
  document: { createElement: (t: string) => (t === "canvas" ? fakeCanvas() : fakeEl()), createElementNS: fakeCanvas, body: { append() {} } },
  window: globalThis,
  matchMedia: () => ({ matches: false }),
  innerHeight: 720,
  innerWidth: 1280,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame() {},
  location: { search: "", hostname: "localhost" },
});

export {};
