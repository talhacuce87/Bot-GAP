// Tuş atamaları: her eyleme iki tuş (klavye `code`'u, fare düğmesi ya da tekerlek yönü).
// Cihazda (localStorage) saklanır; ayarlar panelinden değiştirilir. Klavye düzeninden bağımsız: fiziksel tuş.
// İki ayrı takım (profil) var: dünya ve stadyum. Stadyuma ışınlanınca stadyum tuşları geçerli olur
// (Q pas, F şut, H power şut, G aşırtma, E çalım, R rainbow, C müdahale, B takım); ayarlar paneli o an geçerli takımı gösterir.
// Voleybol salonunda da kendi takımı var (Volleyball 4.2 düzeni): sol tık manşet/smaç, 1 smaç↔blok, 2 dump,
// 3 dalış, F/R pas, B pas türü, Q/E güç (Z/X/C: 1/8/15), V servis, T sprint, G antrenman topu, P pozisyon.
// Orada sol tık ve 1–6 da atanabilir. Paintball maçında da (birinci şahıs): sol tık ateş, Ctrl/C çömel, R doldur.

export type Profile = "world" | "stadium" | "volley" | "paintball";
const KEYS: Record<Profile, string> = { world: "gap-keys", stadium: "gap-keys-stadium", volley: "gap-keys-volley2", paintball: "gap-keys-paintball" };

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
  | "accept"
  | "build"
  | "map"
  | "car"
  | "radio"
  | "net"
  | "fbPass"
  | "fbShoot"
  | "fbLob"
  | "fbSkill"
  | "fbTackle"
  | "fbPower"
  | "fbRainbow"
  | "fbTeam"
  | "vHit"
  | "vMode"
  | "vDump"
  | "vDive"
  | "vSetF"
  | "vSetB"
  | "vPowDown"
  | "vPowUp"
  | "vPow1"
  | "vPow8"
  | "vPow15"
  | "vSetType"
  | "vServe"
  | "vToss"
  | "vTeam"
  | "pbFire"
  | "pbCrouch"
  | "pbReload"
  | "pbLeave";

const FOOTBALL: readonly Action[] = ["fbPass", "fbShoot", "fbPower", "fbLob", "fbSkill", "fbRainbow", "fbTackle", "fbTeam"];
const PAINTBALL: readonly Action[] = ["pbFire", "pbCrouch", "pbReload", "pbLeave"];
const VOLLEY: readonly Action[] = [
  "vHit", "vMode", "vDump", "vDive", "vSetF", "vSetB", "vSetType", "vPowDown", "vPowUp", "vPow1", "vPow8", "vPow15", "vServe", "vToss", "vTeam",
];

/** Tek seferlik kısayollar (menü, fotoğraf, araç, stadyumda futbol, voleybol…): Input bunları sıraya alır, oyun tüketir. */
export const HOTKEYS: readonly Action[] = [
  "menu", "quests", "card", "album", "photo", "camera", "vehicle", "five", "hug", "accept", "build", "map", "car", "radio", "net",
  ...FOOTBALL, ...VOLLEY, "pbReload", "pbLeave",
];

/** Her takımda ayarlanabilen eylemler (sırasıyla panelde). */
export const PROFILE_ACTIONS: Record<Profile, readonly Action[]> = {
  world: [
    "forward", "back", "left", "right", "run", "jump", "shiftlock", "sit", "actF", "actG", "wardrobe", "zoomIn", "zoomOut",
    "menu", "quests", "card", "album", "photo", "camera", "vehicle", "five", "hug", "accept", "build", "map", "car", "radio", "net",
  ],
  stadium: [...FOOTBALL, "forward", "back", "left", "right", "run", "jump", "shiftlock", "zoomIn", "zoomOut", "menu", "camera", "net"],
  volley: [...VOLLEY, "forward", "back", "left", "right", "run", "jump", "shiftlock", "zoomIn", "zoomOut", "menu", "camera", "net"],
  paintball: [...PAINTBALL, "forward", "back", "left", "right", "jump", "menu", "net"],
};

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
  build: "İnşa modu",
  map: "Harita",
  car: "Araçlarım (araba çağır)",
  radio: "Araba radyosu",
  net: "Ağ paneli",
  fbPass: "Pas",
  fbShoot: "Şut (basılı tut: sert)",
  fbLob: "Aşırtma (basılı tut)",
  fbSkill: "Çalım",
  fbTackle: "Müdahale (koşarken: kayarak)",
  fbPower: "Power şut (basılı tut)",
  fbRainbow: "Rainbow çalım",
  fbTeam: "Takım menüsü",
  vHit: "Manşet (havada: smaç)",
  vMode: "Zıplama modu: smaç / blok",
  vDump: "Dump (havada)",
  vDive: "Dalış",
  vSetF: "Pas (öne)",
  vSetB: "Pas (arkaya)",
  vPowDown: "Güç azalt",
  vPowUp: "Güç arttır",
  vPow1: "Güç 1",
  vPow8: "Güç 8",
  vPow15: "Güç 15",
  vSetType: "Pas türü (normal/yüksek/hızlı)",
  vServe: "Servis",
  vToss: "Antrenman topu",
  vTeam: "Voleybol menüsü",
  pbFire: "Ateş (basılı tut: seri)",
  pbCrouch: "Çömel (basılı tut)",
  pbReload: "Hazneyi doldur",
  pbLeave: "Maçtan çekil",
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
  build: ["KeyN", ""],
  map: ["KeyU", ""],
  car: ["KeyT", ""],
  radio: ["KeyR", ""],
  net: ["F3", ""],
  fbPass: ["", ""],
  fbShoot: ["", ""],
  fbLob: ["", ""],
  fbSkill: ["", ""],
  fbTackle: ["", ""],
  fbPower: ["", ""],
  fbRainbow: ["", ""],
  fbTeam: ["", ""],
  vHit: ["", ""],
  vMode: ["", ""],
  vDump: ["", ""],
  vDive: ["", ""],
  vSetF: ["", ""],
  vSetB: ["", ""],
  vPowDown: ["", ""],
  vPowUp: ["", ""],
  vPow1: ["", ""],
  vPow8: ["", ""],
  vPow15: ["", ""],
  vSetType: ["", ""],
  vServe: ["", ""],
  vToss: ["", ""],
  vTeam: ["", ""],
  pbFire: ["", ""],
  pbCrouch: ["", ""],
  pbReload: ["", ""],
  pbLeave: ["", ""],
};

const NONE = Object.fromEntries(Object.keys(DEFAULT_BINDS).map((a) => [a, ["", ""]])) as Record<Action, [Bind, Bind]>;

/** Stadyum: futbol tuşları; dünyanın E/Q/C/F/G işleri (otur, görevler, gardırop, etkileşim) burada yok. */
export const STADIUM_BINDS: Record<Action, [Bind, Bind]> = {
  ...NONE,
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  run: ["ShiftLeft", ""],
  jump: ["Space", ""],
  shiftlock: ["ShiftRight", ""],
  zoomIn: ["WheelUp", ""],
  zoomOut: ["WheelDown", ""],
  menu: ["KeyM", ""],
  camera: ["KeyV", ""],
  net: ["F3", ""],
  fbPass: ["KeyQ", ""],
  fbShoot: ["KeyF", ""],
  fbLob: ["KeyG", ""],
  fbSkill: ["KeyE", ""],
  fbTackle: ["KeyC", ""],
  fbPower: ["KeyH", ""],
  fbRainbow: ["KeyR", ""],
  fbTeam: ["KeyB", ""],
};

/**
 * Voleybol salonu (Volleyball 4.2 düzeni): yerde sol tık manşet, havada smaç; 1 zıplama modu (smaç/blok),
 * 2 dump, 3 dalış, F/R öne/arkaya pas, B pas türü, Q/E güç (Z/X/C: 1, 8, 15), V servis, T sprint, P pozisyon;
 * Shift shift lock (kamera ile nişan).
 */
export const VOLLEY_BINDS: Record<Action, [Bind, Bind]> = {
  ...NONE,
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  run: ["KeyT", ""],
  jump: ["Space", ""],
  shiftlock: ["ShiftLeft", "ShiftRight"],
  zoomIn: ["WheelUp", ""],
  zoomOut: ["WheelDown", ""],
  menu: ["KeyM", ""],
  camera: ["", ""],
  net: ["F3", ""],
  vHit: ["Mouse0", ""],
  vMode: ["Digit1", ""],
  vDump: ["Digit2", ""],
  vDive: ["Digit3", ""],
  vSetF: ["KeyF", ""],
  vSetB: ["KeyR", ""],
  vPowDown: ["KeyQ", ""],
  vPowUp: ["KeyE", ""],
  vPow1: ["KeyZ", ""],
  vPow8: ["KeyX", ""],
  vPow15: ["KeyC", ""],
  vSetType: ["KeyB", ""],
  vServe: ["KeyV", ""],
  vToss: ["KeyG", ""],
  vTeam: ["KeyP", ""],
};

/**
 * Paintball maçı (birinci şahıs): yürü, zıpla, sol tık ateş (basılı: seri), Ctrl ya da C çömel, R doldur, G çekil.
 * Koşu yok; dünyanın kısayolları (gardırop, görevler…) maçta kapalı.
 */
export const PAINTBALL_BINDS: Record<Action, [Bind, Bind]> = {
  ...NONE,
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space", ""],
  menu: ["KeyM", ""],
  net: ["F3", ""],
  pbFire: ["Mouse0", ""],
  pbCrouch: ["ControlLeft", "KeyC"],
  pbReload: ["KeyR", ""],
  pbLeave: ["KeyG", ""],
};

const DEFAULTS: Record<Profile, Record<Action, [Bind, Bind]>> = { world: DEFAULT_BINDS, stadium: STADIUM_BINDS, volley: VOLLEY_BINDS, paintball: PAINTBALL_BINDS };

/** Atanamaz tuşlar: sohbet, menü kapatma, emote ve sol/sağ tık (seçim ve kamera). */
export const RESERVED = new Set(["Enter", "NumpadEnter", "Escape", "Mouse0", "Mouse2", ...[1, 2, 3, 4, 5, 6].map((n) => `Digit${n}`)]);
/** Voleybol salonunda ve paintball maçında sol tık ve rakamlar da atanabilir (emote yok, sol tık vuruş/ateş). */
const VOLLEY_FREE = new Set(["Mouse0", ...[1, 2, 3, 4, 5, 6].map((n) => `Digit${n}`)]);

/** Bu takımda atanamaz mı. */
export function reserved(bind: Bind, p: Profile = profile): boolean {
  return RESERVED.has(bind) && !((p === "volley" || p === "paintball") && VOLLEY_FREE.has(bind));
}

function load(p: Profile): Record<Action, [Bind, Bind]> {
  const b = structuredClone(DEFAULTS[p]);
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS[p]) || "{}") as Partial<Record<Action, unknown>>;
    for (const a of PROFILE_ACTIONS[p]) {
      const v = saved[a];
      if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string" && !reserved(x, p))) b[a] = [v[0], v[1]];
    }
  } catch {
    // depolama kapalı ya da bozuk: varsayılanlar
  }
  return b;
}

const sets: Record<Profile, Record<Action, [Bind, Bind]>> = { world: load("world"), stadium: load("stadium"), volley: load("volley"), paintball: load("paintball") };
/** Geçerli takım ve atamaları (canlı bağ: setProfile ile değişir). */
export let profile: Profile = "world";
export let binds: Record<Action, [Bind, Bind]> = sets.world;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function save(): void {
  try {
    localStorage.setItem(KEYS[profile], JSON.stringify(binds));
  } catch {
    // depolama kapalı: yalnızca bu oturumda geçerli
  }
  notify();
}

/** Stadyuma girince/çıkınca geçerli tuş takımını değiştirir. */
export function setProfile(p: Profile): void {
  if (p === profile) return;
  profile = p;
  binds = sets[p];
  notify();
}

/**
 * `action`ın `slot`una `bind`ı atar. Aynı tuş başka bir eylemdeyse oradan alınır;
 * alınan eylem döner (panel uyarı gösterir).
 */
export function setBind(action: Action, slot: 0 | 1, bind: Bind): Action | null {
  let taken: Action | null = null;
  if (bind) {
    for (const a of PROFILE_ACTIONS[profile]) {
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
  Object.assign(binds, structuredClone(DEFAULTS[profile]));
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
  Mouse0: "Sol tık",
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
