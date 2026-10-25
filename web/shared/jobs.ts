// İşler (RP): kuryelik ve taksicilik. Telefonun İşler uygulamasından girilir; işe girince işin aracı verilir (kuryeye
// GAP Kurye scooter'ı, taksiciye sarı GAP Taksi). Görev hedefleri yolların üstündeki adlı duraklardır (araba ve
// yaya varabilir). Ücretler mesafeyle artar; kuryede zamanında teslim bonusu var. Bütün denge değerleri burada.
import { PLOTS } from "./build";
import { CASINO, CITY_DX, GALLERY_AREA, FAME, GARAGE, GROVE, KAHVEHANE, LAKE, PLAZA, ROADS, STREETS, VILLAGE_ROADS } from "./zones";

export type JobKind = "kurye" | "taksi";

export const JOBS: Record<JobKind, { name: string; icon: string; model: "motor" | "taksi"; desc: string }> = {
  kurye: { name: "Kuryelik", icon: "📦", model: "motor", desc: "Paketleri zamanında teslim et" },
  taksi: { name: "Taksicilik", icon: "🚕", model: "taksi", desc: "Müşterileri gideceği yere götür" },
};

/** İşin araç modelleri: yalnızca o işteyken sürülür (garajda/çağırma menüsünde yok). */
export const JOB_MODELS = ["motor", "taksi"] as const;

export const JOB_PAY = {
  /** Kurye: en az/en çok ücret, metre başına ve zamanında teslim bonusu (oran). */
  kuryeMin: 250,
  kuryeMax: 450,
  kuryePerM: 0.45,
  onTime: 0.2,
  /** Süre: mesafe / bu hız (m/sn) + pay (sn). */
  kuryeSpeed: 9,
  kuryeSlack: 30,
  /** Taksi (NPC müşteri): en az/en çok ücret ve metre başına. */
  taksiMin: 300,
  taksiMax: 700,
  taksiPerM: 0.7,
  /** Oyuncu yolcu: taksimetre açılış ücreti ve 100 m başına. */
  meterStart: 50,
  meterPer100: 12,
  /** Hedefe bu kadar yaklaşınca (m) ve bu hızın altında (m/sn) varılmış sayılır. */
  reach: 7,
  stopSpeed: 3,
};

/** Adlı durak: yolun üstünde (ya da mahallede arsanın önündeki caddede). */
export interface Place {
  name: string;
  x: number;
  z: number;
}

/** Otoban, köy yolları ve şehrin caddeleri (2 m aralıklı noktalar). */
const roadPts: [number, number][] = [...ROADS, ...VILLAGE_ROADS].flat();
for (const s of STREETS) {
  const n = Math.max(1, Math.round(Math.hypot(s.bx - s.ax, s.bz - s.az) / 2));
  for (let k = 0; k <= n; k++) roadPts.push([s.ax + ((s.bx - s.ax) * k) / n, s.az + ((s.bz - s.az) * k) / n]);
}

/** Bir noktaya en yakın yol noktası. */
function onRoad(x: number, z: number): [number, number] {
  let best = roadPts[0], bd = Infinity;
  for (const p of roadPts) {
    const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
    if (d < bd) (bd = d), (best = p);
  }
  return best;
}

const place = (name: string, x: number, z: number, road = true): Place => {
  const [px, pz] = road ? onRoad(x, z) : [x, z];
  return { name, x: Math.round(px * 10) / 10, z: Math.round(pz * 10) / 10 };
};

/** Kurye paketleri buralardan alınır. */
export const PICKUPS: Place[] = [
  place("GAP Market", 445 + CITY_DX, -13.5),
  place("GAP Kahve", 400 + CITY_DX, -70),
  place("GAP AVM (Burger)", 487 + CITY_DX, -13.5),
  place("Kahvehane", KAHVEHANE.x, KAHVEHANE.z),
  place("Simitçi Hüsnü", PLAZA.x - 4.5, PLAZA.z + 1.5, false),
];

/** Teslimat ve taksi hedefleri: mahalle arsaları (caddedeki önü) ve köy/şehir noktaları. */
export const PLACES: Place[] = [
  ...PLOTS.map((p) => place(`Mahalle Arsa ${p.id + 1}`, p.x0 + p.size / 2, p.front < 0 ? p.z0 - 5 : p.z0 + p.size + 5, false)),
  place("Köy meydanı", PLAZA.x, PLAZA.z - 6, false),
  place("Kahvehane", KAHVEHANE.x, KAHVEHANE.z),
  place("Göl iskelesi", LAKE.x - LAKE.r, LAKE.z),
  place("Şöhret kürsüsü", FAME.x, FAME.z),
  place("Mangal alanı", GROVE.x, GROVE.z),
  place("Kapalı saha", 69, 35),
  place("Mahalle kavşağı", -225, -14),
  place("GAP Casino", CASINO.x, CASINO.z),
  place("GAP Garaj", GARAGE.x, GARAGE.z),
  place("GAP Market", 445 + CITY_DX, -13.5),
  place("GAP Kahve", 400 + CITY_DX, -70),
  place("GAP AVM", 487 + CITY_DX, -13.5),
  place("GAP Galeri", GALLERY_AREA.minX + 3, 10, false),
];

/** Kurye ücreti (mesafe, m) ve süre sınırı (ms). */
export const courierPay = (d: number) => Math.round(Math.min(JOB_PAY.kuryeMax, Math.max(JOB_PAY.kuryeMin, JOB_PAY.kuryeMin + d * JOB_PAY.kuryePerM)) / 5) * 5;
export const courierTime = (d: number) => Math.round((d / JOB_PAY.kuryeSpeed + JOB_PAY.kuryeSlack) * 1000);
/** NPC taksi ücreti (mesafe, m). */
export const taxiFare = (d: number) => Math.round(Math.min(JOB_PAY.taksiMax, Math.max(JOB_PAY.taksiMin, JOB_PAY.taksiMin + d * JOB_PAY.taksiPerM)) / 5) * 5;
/** Oyuncu yolcunun taksimetresi (gidilen metre). */
export const meterFare = (m: number) => Math.round(JOB_PAY.meterStart + (m / 100) * JOB_PAY.meterPer100);

/** Ekrandaki görev (yalnızca işi yapana). */
export interface JobView {
  kind: JobKind;
  /** Aşama: kurye paketi alacak / teslim edecek; taksi müşteri bekliyor / götürüyor / oyuncu yolcu (taksimetre). */
  phase: "pickup" | "deliver" | "fetch" | "ride" | "meter" | "idle";
  /** Hedef durak. */
  target: Place | null;
  /** Ödül (taksimetrede şu anki ücret). */
  pay: number;
  /** Süre sınırı (sunucu saati, 0 yok). */
  until: number;
  /** Bugün bu işte yapılan ve kazanılan. */
  done: number;
  earned: number;
  /** Taksi müşterisinin adı (NPC ya da oyuncu). */
  who?: string;
  /** Bekleyen NPC müşteri (taksi, müşteriyi alırken): yalnızca taksiciye çizilir. */
  npc?: { x: number; z: number; name: string } | null;
}

/** Bekleyen taksi çağrısı (oyuncu): taksicilerin haritasında görünür. */
export interface TaxiCall {
  sid: number;
  name: string;
  x: number;
  z: number;
}

/** NPC müşteri adları. */
export const CUSTOMER_NAMES = ["Ayşe", "Mehmet", "Fatma", "Ahmet", "Zeynep", "Mustafa", "Elif", "Hasan", "Emine", "Hüseyin", "Cem", "Selin", "Burak", "Deniz", "Kader", "Oğuz"];

/** Etkinlik ödülleri (kazanana; GAP Ring'in kendi derece ödülleri var: shared/ring RACE_PRIZES). */
export const EVENT_REWARDS: Record<string, { amount: number; reason: string; icon: string }> = {
  match_win: { amount: 800, reason: "Futbol maçı galibiyeti", icon: "⚽" },
  pb_win: { amount: 600, reason: "Paintball galibiyeti", icon: "🎯" },
  race_win: { amount: 700, reason: "Oyuncak pist yarışı birinciliği", icon: "🏎️" },
  tank_win: { amount: 600, reason: "Tank savaşı galibiyeti", icon: "⚔️" },
  tag_win: { amount: 500, reason: "Ebelemece / saklambaç galibiyeti", icon: "🏃" },
};
/** Aynı etkinlikten günde en çok bu kadar ödül (arkadaşla tekrar tekrar oynayıp para basılmasın). */
export const EVENT_DAILY_MAX = 5;
