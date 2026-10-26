// HUD yerleşimi: ekran köşe ve kenarlarında sabit bölgeler. Her parça kendi bölgesine eklenir, bölge içinde alt alta
// dizilir; böylece görev kartı, bildirim, etkileşim düğmesi, hızlı slot gibi parçalar hiçbir zaman üst üste binmez.
// Sağ üstte tek araç çubuğu (para + kısayol düğmeleri, seyrek kullanılanlar "Diğer" menüsünde); açılır pencereler
// aynı anda tek tane açık kalır.
import { listen } from "../mode";
import { type Action, actionLabel, onBinds } from "../input/keybinds";
import { type IconName, icon } from "./icons";

/** tl/tc/tr: üst sol/orta/sağ · bl/bc/br: alt sol/orta/sağ. */
export type Region = "tl" | "tc" | "tr" | "bl" | "bc" | "br";

/** Bölgenin kabı (yoksa kurulur). Mod değişince HUD boşaltılır; bölgeler ilk istekte yeniden kurulur. */
export function region(root: HTMLElement, r: Region): HTMLDivElement {
  let box = root.querySelector<HTMLDivElement>(`:scope > .hud-${r}`);
  if (!box) {
    box = document.createElement("div");
    box.className = `hud-region hud-${r}`;
    root.append(box);
  }
  return box;
}

/** Sağ üstteki araç çubuğu. */
export function toolbar(root: HTMLElement): HTMLDivElement {
  const tr = region(root, "tr");
  let bar = tr.querySelector<HTMLDivElement>(":scope > .toolbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "toolbar";
    bar.setAttribute("role", "toolbar");
    tr.append(bar);
  }
  return bar;
}

export interface ToolOpts {
  icon: IconName;
  /** Açıklama (ipucu balonu ve erişilebilir ad). */
  label: string;
  /** Kısayolun eylemi: ipucunda geçerli tuşu gösterilir (tuş değişince güncellenir; dokunmatikte verilmez). */
  action?: Action;
  /** Küme (0: kişisel, 1: diğer, 2: ayarlar) ve küme içindeki sıra. */
  group: 0 | 1 | 2;
  order: number;
  cls?: string;
  onClick: () => void;
}

/** Kümelerin ilk öğesine ayraç sınıfı (öğe eklendikçe yeniden). */
function regroup(bar: HTMLElement): void {
  const items = [...bar.children].filter((x): x is HTMLElement => x instanceof HTMLElement && !!x.dataset.group);
  items.sort((p, q) => Number(p.style.order) - Number(q.style.order));
  let last = "";
  for (const x of items) {
    x.classList.toggle("group-start", !!last && x.dataset.group !== last);
    last = x.dataset.group!;
  }
}

/** Araç çubuğuna simgeli düğme ekler. */
export function toolButton(root: HTMLElement, o: ToolOpts): HTMLButtonElement {
  const bar = toolbar(root);
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tool-btn${o.cls ? ` ${o.cls}` : ""}`;
  b.dataset.group = String(o.group);
  b.style.order = String(o.group * 100 + o.order);
  icon(o.icon, "", b);
  b.dataset.label = o.label;
  if (o.action) b.dataset.action = o.action;
  setToolTip(b, o.label, o.action && actionLabel(o.action));
  b.addEventListener("click", () => o.onClick());
  bar.append(b);
  regroup(bar);
  return b;
}

// Tuş atamaları değişince araç çubuğundaki ipuçları yeni tuşu göstersin
onBinds(() => {
  for (const b of document.querySelectorAll<HTMLElement>(".tool-btn[data-action]")) setToolTip(b, b.dataset.label ?? "", actionLabel(b.dataset.action as Action));
});

/**
 * Araç çubuğundaki "Diğer" menüsüne (sinema, ekran paylaşımı, tank savaşı) satır ekler. Menü ilk satırla kurulur;
 * dışarı tıklayınca, Esc ile ya da bir satır seçilince kapanır.
 */
export function toolMenuItem(root: HTMLElement, o: { icon: IconName; label: string; order: number; onClick: () => void }): HTMLButtonElement {
  const bar = toolbar(root);
  let wrap = bar.querySelector<HTMLDivElement>(":scope > .tool-wrap");
  if (!wrap) {
    const w = (wrap = document.createElement("div"));
    w.className = "tool-wrap";
    w.dataset.group = "1";
    w.style.order = "100";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-btn";
    icon("grid", "", btn);
    setToolTip(btn, "Diğer");
    btn.setAttribute("aria-haspopup", "menu");
    const menu = document.createElement("div");
    menu.className = "tool-menu";
    menu.setAttribute("role", "menu");
    w.append(btn, menu);
    bar.append(w);
    regroup(bar);
    const close = () => {
      menu.classList.remove("show");
      btn.classList.remove("open");
    };
    btn.addEventListener("click", () => {
      const show = !menu.classList.contains("show");
      menu.classList.toggle("show", show);
      btn.classList.toggle("open", show);
      btn.classList.remove("pulse");
    });
    listen("pointerdown", (e) => {
      if (menu.classList.contains("show") && !w.contains(e.target as Node)) close();
    }, true);
    listen("keydown", (e) => {
      if (e.key === "Escape" && menu.classList.contains("show")) close();
    });
  }
  const w = wrap;
  const menu = w.querySelector<HTMLDivElement>(".tool-menu")!;
  const item = document.createElement("button");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.style.order = String(o.order);
  icon(o.icon, "", item);
  const text = document.createElement("span");
  text.textContent = o.label;
  item.append(text);
  item.addEventListener("click", () => {
    menu.classList.remove("show");
    w.querySelector(".tool-btn")?.classList.remove("open");
    o.onClick();
  });
  menu.append(item);
  return item;
}

/**
 * Modların kendi düğmeleri (stadyum, tank savaşı: dünyaya dön, takım, tuşlar): sol üstte tek sıra.
 * `toggle`: başta gizli, `.show` sınıfıyla görünür.
 */
export function modeButton(root: HTMLElement, o: { icon: IconName; label: string; onClick: () => void; toggle?: boolean; cls?: string }): HTMLButtonElement {
  const tl = region(root, "tl");
  let bar = tl.querySelector<HTMLDivElement>(":scope > .mode-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "mode-bar";
    tl.append(bar);
  }
  const b = document.createElement("button");
  b.type = "button";
  b.className = `mode-btn${o.toggle ? " opt" : ""}${o.cls ? ` ${o.cls}` : ""}`;
  icon(o.icon, "", b);
  const t = document.createElement("span");
  t.textContent = o.label;
  b.append(t);
  b.addEventListener("click", () => o.onClick());
  bar.append(b);
  return b;
}

/** "Diğer" menüsünün düğmesi dikkat çeksin (ör. paylaşım linkiyle gelene). */
export function pulseToolMenu(root: HTMLElement): void {
  toolbar(root).querySelector(".tool-wrap > .tool-btn")?.classList.add("pulse");
}

/** Düğmenin ipucu: "Harita · M". */
export function setToolTip(b: HTMLElement, label: string, key?: string): void {
  b.dataset.tip = key ? `${label} · ${key}` : label;
  b.setAttribute("aria-label", label);
}

// ---- Açılır pencereler: aynı anda tek pencere, arkada karartma ----

interface Modal {
  close(): void;
}

const open = new Set<Modal>();
let scrimEl: HTMLDivElement | null = null;

/** Pencerelerin arkasındaki karartma: tıklayınca açık pencere kapanır. */
function scrim(root: HTMLElement): HTMLDivElement {
  if (scrimEl?.parentElement !== root) {
    const s = (scrimEl = document.createElement("div"));
    s.className = "ui-scrim";
    s.addEventListener("pointerdown", (e) => {
      if (e.target !== s) return;
      for (const m of [...open]) m.close();
    });
    root.append(s);
  }
  return scrimEl!;
}

/** Pencere açılıyor: açık olan diğerleri kapanır; `root` verilirse arkası kararır. */
export function modalOpened(m: Modal, root?: HTMLElement): void {
  for (const other of [...open]) if (other !== m) other.close();
  open.add(m);
  if (root) scrim(root).classList.add("show");
  else scrimEl?.classList.remove("show");
}

export function modalClosed(m: Modal): void {
  open.delete(m);
  if (!open.size) scrimEl?.classList.remove("show");
}

/** Herhangi bir pencere açık mı. */
export function anyModal(): boolean {
  return open.size > 0;
}
