// Tuş atamaları: her eyleme iki tuş (klavye `code`'u, fare düğmesi ya da tekerlek yönü).
// Cihazda (localStorage) saklanır; ayarlar panelinden değiştirilir. Klavye düzeninden bağımsız: fiziksel tuş.

const KEY = "gap-keys";

export type Action =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "run"
  | "jump"
  | "shiftlock"
  | "sit"
  | "actF"
  | "actG"
  | "wardrobe"
  | "zoomIn"
  | "zoomOut"
  | "menu"
  | "quests"
  | "card"
  | "album"
  | "photo"
  | "camera"
  | "vehicle"
  | "five"
  | "hug"
  | "accept";

/** Tek seferlik dünya kısayolları (menü, fotoğraf, araç…): Input bunları sıraya alır, oyun tüketir. */
export const HOTKEYS: readonly Action[] = ["menu", "quests", "card", "album", "photo", "camera", "vehicle", "five", "hug", "accept"];

/** Tuş adı: KeyboardEvent.code, "Mouse1" (orta), "Mouse3"/"Mouse4" (yan), "WheelUp"/"WheelDown". */
export type Bind = string;

export const ACTION_NAMES: Record<Action, string> = {
  forward: "İleri",
  back: "Geri",
  left: "Sol",
  right: "Sağ",
  run: "Koş (basılı tut)",
  jump: "Zıpla",
  shiftlock: "Shift lock",
  sit: "Otur / kalk",
  actF: "Etkileşim 1",
  actG: "Etkileşim 2",
  wardrobe: "Gardırop",
  zoomIn: "Yakınlaş",
  zoomOut: "Uzaklaş",
  menu: "Menü",
  quests: "Görevler",
  card: "Oyuncu kartım",
  album: "Balık albümü",
  photo: "Fotoğraf modu",
  camera: "Birinci/üçüncü şahıs",
  vehicle: "Bisiklet/kaykay",
  five: "Beşlik çak",
  hug: "Sarıl",
  accept: "İsteği kabul et",
};

export const DEFAULT_BINDS: Record<Action, [Bind, Bind]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  run: ["ShiftLeft", ""],
  jump: ["Space", ""],
  shiftlock: ["ShiftRight", ""],
  sit: ["KeyE", ""],
  actF: ["KeyF", ""],
  actG: ["KeyG", ""],
  wardrobe: ["KeyC", ""],
  zoomIn: ["WheelUp", ""],
  zoomOut: ["WheelDown", ""],
  menu: ["KeyM", ""],
  quests: ["KeyQ", ""],
  card: ["KeyK", ""],
  album: ["KeyL", ""],
  photo: ["KeyP", ""],
  camera: ["KeyV", ""],
  vehicle: ["KeyB", ""],
  five: ["KeyH", ""],
  hug: ["KeyJ", ""],
  accept: ["KeyY", ""],
};

/** Atanamaz tuşlar: sohbet, menü kapatma, emote ve sol/sağ tık (seçim ve kamera). */
export const RESERVED = new Set(["Enter", "NumpadEnter", "Escape", "Mouse0", "Mouse2", ...[1, 2, 3, 4, 5, 6].map((n) => `Digit${n}`)]);

function load(): Record<Action, [Bind, Bind]> {
  const b = structuredClone(DEFAULT_BINDS);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Record<Action, unknown>>;
    for (const a of Object.keys(b) as Action[]) {
      const v = saved[a];
      if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string" && !RESERVED.has(x))) b[a] = [v[0], v[1]];
    }
  } catch {
    // depolama kapalı ya da bozuk: varsayılanlar
  }
  return b;
}

export const binds: Record<Action, [Bind, Bind]> = load();
const listeners = new Set<() => void>();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(binds));
  } catch {
    // depolama kapalı: yalnızca bu oturumda geçerli
  }
  for (const fn of listeners) fn();
}

/**
 * `action`ın `slot`una `bind`ı atar. Aynı tuş başka bir eylemdeyse oradan alınır;
 * alınan eylem döner (panel uyarı gösterir).
 */
export function setBind(action: Action, slot: 0 | 1, bind: Bind): Action | null {
  let taken: Action | null = null;
  if (bind) {
    for (const a of Object.keys(binds) as Action[]) {
      binds[a].forEach((x, i) => {
        if (x === bind && !(a === action && i === slot)) {
          binds[a][i] = "";
          if (a !== action) taken = a;
        }
      });
    }
  }
  binds[action][slot] = bind;
  save();
  return taken;
}

export function resetBinds(): void {
  Object.assign(binds, structuredClone(DEFAULT_BINDS));
  save();
}

/** Atamalar değişince çağrılır; dönen işlev dinlemeyi bırakır. */
export function onBinds(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Bu tuşa atanmış eylemler. */
export function actionsOf(bind: Bind): Action[] {
  const out: Action[] = [];
  for (const a of Object.keys(binds) as Action[]) if (binds[a].includes(bind)) out.push(a);
  return out;
}

const MOUSE_NAMES: Record<string, string> = {
  Mouse1: "Orta tık",
  Mouse3: "Fare geri",
  Mouse4: "Fare ileri",
  WheelUp: "Tekerlek ↑",
  WheelDown: "Tekerlek ↓",
};

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  ShiftLeft: "Sol Shift",
  ShiftRight: "Sağ Shift",
  ControlLeft: "Sol Ctrl",
  ControlRight: "Sağ Ctrl",
  AltLeft: "Sol Alt",
  AltRight: "Sağ Alt",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  CapsLock: "Caps Lock",
  Tab: "Tab",
  Backspace: "Backspace",
  Backquote: "`",
};

/** Ekranda gösterilecek ad ("" → "—"). */
export function bindLabel(b: Bind): string {
  if (!b) return "—";
  if (MOUSE_NAMES[b]) return MOUSE_NAMES[b];
  if (KEY_NAMES[b]) return KEY_NAMES[b];
  if (b.startsWith("Key")) return b.slice(3);
  if (b.startsWith("Digit")) return b.slice(5);
  if (b.startsWith("Numpad")) return `Num ${b.slice(6)}`;
  return b;
}

/** Eylemin ilk atanmış tuşunun adı (ipucu metinleri için). */
export function actionLabel(a: Action): string {
  return bindLabel(binds[a][0] || binds[a][1]);
}
