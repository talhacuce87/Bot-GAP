// Dünya ↔ tank savaşı geçişi, sayfa yenilenmeden: çalışan mod durdurulur (döngü, bağlantı, katmanlar),
// diğeri aynı oturumla başlar. Discord Activity çerçevesinde sayfayı yeniden yüklemek güvenilir değil
// (mod tercihi kayboluyor, dünya yeniden açılıyor).

const MODE_KEY = "gap-mode";

/** Çalışan modun ömrü: `active` durunca false olur; durdurma işleri sırayla çalışır. */
export interface ModeLife {
  active: boolean;
  onStop(fn: () => void): void;
}

let current: { life: ModeLife; stops: (() => void)[]; abort: AbortController } | null = null;
let starter: ((battle: boolean) => void) | null = null;

/** Yeni mod başlarken çağrılır; önceki mod (varsa) durdurulmuş olmalı. */
export function beginMode(): ModeLife {
  const stops: (() => void)[] = [];
  const life: ModeLife = { active: true, onStop: (fn) => stops.push(fn) };
  current = { life, stops, abort: new AbortController() };
  return life;
}

/**
 * Pencereye/belgeye mod ömrü boyunca dinleyici: mod durunca kaldırılır. Her mod başlangıcında yeniden kurulan arayüz
 * ve dünya parçaları bunu kullanır; yoksa dünya ↔ tank geçişinde eski kopyalar tuşlara tepki vermeye ve eski
 * arayüz ağacını bellekte tutmaya devam eder. Modül düzeyinde tek sefer kurulanlar (ses kilidi vb.) düz addEventListener kullanır.
 */
function withLife(opts?: boolean | AddEventListenerOptions): AddEventListenerOptions {
  const o = typeof opts === "boolean" ? { capture: opts } : { ...opts };
  if (current && !o.signal) o.signal = current.abort.signal;
  return o;
}
export function listen<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void;
export function listen(type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void;
export function listen(type: string, fn: (e: never) => void, opts?: boolean | AddEventListenerOptions): void {
  addEventListener(type, fn as EventListener, withLife(opts));
}
export function listenDoc<K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void {
  document.addEventListener(type, fn as EventListener, withLife(opts));
}

/** Çalışan modu durdurur (hatalar diğer durdurma işlerini engellemez). */
export function stopMode(): void {
  const c = current;
  current = null;
  if (!c) return;
  c.life.active = false;
  c.abort.abort();
  for (const fn of c.stops.reverse()) {
    try {
      fn();
    } catch (err) {
      console.warn("[mode]", err);
    }
  }
}

/** main.ts kurar: modu durdurup diğerini başlatan işlev. */
export function setModeStarter(fn: (battle: boolean) => void): void {
  starter = fn;
}

/** `?battle=1` (paylaşılabilir/test linki) ya da sekmede saklanan tercih. */
export function wantsBattle(): boolean {
  const param = new URLSearchParams(location.search).get("battle");
  if (param !== null) return param === "1";
  try {
    return sessionStorage.getItem(MODE_KEY) === "battle";
  } catch {
    return false;
  }
}

/** Savaşa gir / dünyaya dön. Tercih adrese ve sekmeye de yazılır (sayfa elle yenilenirse aynı modda açılsın). */
export function switchMode(battle: boolean): void {
  try {
    if (battle) sessionStorage.setItem(MODE_KEY, "battle");
    else sessionStorage.removeItem(MODE_KEY);
  } catch {
    // depolama kapalı
  }
  try {
    const url = new URL(location.href);
    url.searchParams.set("battle", battle ? "1" : "0");
    history.replaceState(history.state, "", url);
  } catch {
    // adres değiştirilemiyorsa yalnızca bu oturum için geçerli
  }
  if (starter) starter(battle);
  else location.reload();
}
