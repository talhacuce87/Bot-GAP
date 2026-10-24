// Canlı masaların ortak bahis araçları (Evolution tarzı): çip değerleri, masadaki çip yığını ve
// Geri al / Temizle / x2 / Tekrarla düğmeleri.

export const CHIP_VALUES = [10, 25, 100, 500, 1000, 5000];

/** Tutarın rengi: altındaki en büyük çip. */
export const chipTier = (a: number) => [...CHIP_VALUES].reverse().find((v) => a >= v) ?? CHIP_VALUES[0];
export const shortAmount = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(Math.round(n)));

/** Masada duran çip (tutar yazılı). */
export function chipEl(amount: number, cls = ""): HTMLElement {
  const i = document.createElement("i");
  i.className = `cz-bchip c${chipTier(amount)}${cls ? ` ${cls}` : ""}`;
  i.textContent = shortAmount(amount);
  return i;
}

export interface BetToolOpts {
  undo(): void;
  clear(): void;
  double(): void;
  repeat(): void;
  can: { undo: boolean; clear: boolean; double: boolean; repeat: boolean };
}

/** Geri al, Temizle, x2 ve Tekrarla (kısayollar: Backspace, Delete, X, R). */
export function betTools(o: BetToolOpts): HTMLElement {
  const row = document.createElement("div");
  row.className = "cz-bettools";
  const b = (icon: string, label: string, key: string, on: () => void, ok: boolean) => {
    const x = document.createElement("button");
    x.className = "cz-tool";
    x.innerHTML = `<b>${icon}</b><span>${label}</span>`;
    x.title = `${label} (${key})`;
    x.disabled = !ok;
    x.addEventListener("click", on);
    row.append(x);
  };
  b("↶", "Geri al", "Backspace", o.undo, o.can.undo);
  b("✕", "Temizle", "Delete", o.clear, o.can.clear);
  b("×2", "İkiye katla", "X", o.double, o.can.double);
  b("↻", "Tekrarla", "R", o.repeat, o.can.repeat);
  return row;
}
