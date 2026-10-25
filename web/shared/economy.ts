// Hayat ve ekonomi (RP): can, açlık, su, enerji ve GAP ₺. Bütün denge değerleri burada (tek yerden ayarlanır).
// Açlık, su ve enerji yalnızca oyundayken azalır (su açlıktan hızlı); koşmak enerjiyi hızlı bitirir, oturmak
// doldurur. Açlık ya da su sıfırken can gider; yüksekten düşmek ve hızlı arabanın çarpması da can götürür. Can sıfırlanınca bayılırsın: arkadaşın
// kaldırabilir, yoksa (ya da ambulans çağırırsan) hastanede uyanırsın ve fatura ödersin.

/** Para ve ücretler (GAP ₺). */
export const ECON = {
  /** Yeni oyuncunun başlangıç parası. */
  startMoney: 10_000,
  /** Hastane faturası (süre dolunca ya da ambulans çağırınca). */
  hospitalFee: 300,
  /** Kumarhanede bir günde en çok bu kadar kaybedilir (net). */
  casinoDailyLoss: 30_000,
  /** Cüzdan geçmişinde tutulan işlem sayısı. */
  historyMax: 30,
};

/** Hayat barları ve hızları (yüzde; süreler dakika). */
export const LIFE = {
  /** Açlık, su ve enerjinin 100'den 0'a inme süresi (dk). */
  hungerMinutes: 60,
  thirstMinutes: 40,
  energyMinutes: 90,
  /** Koşarken enerji bu kat hızlı biter; otururken dakikada bu kadar dolar. */
  runFactor: 2,
  seatedEnergyPerMin: 6,
  /** Açlık (ya da su) sıfırken dakikada giden can; açlık, su ve enerji bunun üstündeyken dakikada dolan can. */
  starvePerMin: 5,
  regenAbove: 70,
  regenPerMin: 2,
  /** Bu oranın altında bar yanıp söner (uyarı). */
  warnBelow: 20,
  /** Bayılma süresi (ms), kaldırılınca ve hastanede uyanınca can. */
  downedMs: 60_000,
  reviveHp: 30,
  hospitalHp: 50,
  /** Kaldırmak için bayılana bu kadar yakın olmalı (m). */
  reviveReach: 2.5,
  /** Kaldırma süresi (ms): bu kadar yanında kalmalı (uzaklaşırsa iptal). */
  reviveMs: 3500,
  /** Yüksekten düşme: bu yükseklikten (m) sonra metre başına can. */
  fallFrom: 4,
  fallPerMeter: 8,
  /** Araba çarpması: bu hızın (m/sn) üstünde, fazlası başına can; tek çarpmada en çok. */
  carHitSpeed: 6,
  carHitPerMs: 4,
  hitMax: 60,
};

export interface LifeState {
  hp: number;
  hunger: number;
  thirst: number;
  energy: number;
}

export const FULL_LIFE: LifeState = { hp: 100, hunger: 100, thirst: 100, energy: 100 };

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** `dt` saniye geçti: açlık ve enerji azalır (koşarken hızlı, otururken enerji dolar), can açlığa göre. */
export function stepLife(l: LifeState, dt: number, o: { running: boolean; seated: boolean; tok?: boolean; enerji?: boolean }): LifeState {
  const min = dt / 60;
  // Tok: açlık yarı hızda; enerji içeceği: koşarken enerji bitmez
  const hunger = clamp(l.hunger - (100 / LIFE.hungerMinutes) * min * (o.tok ? 0.5 : 1));
  const thirst = clamp(l.thirst - (100 / LIFE.thirstMinutes) * min);
  const drain = o.enerji && o.running ? 0 : (100 / LIFE.energyMinutes) * min * (o.running ? LIFE.runFactor : 1);
  const energy = clamp(o.seated ? l.energy + LIFE.seatedEnergyPerMin * min : l.energy - drain);
  let hp = l.hp;
  if (hunger <= 0) hp -= LIFE.starvePerMin * min;
  if (thirst <= 0) hp -= LIFE.starvePerMin * min;
  if (hunger > LIFE.regenAbove && thirst > LIFE.regenAbove && energy > LIFE.regenAbove) hp += LIFE.regenPerMin * min;
  return { hp: clamp(hp), hunger, thirst, energy };
}

/** Yüksekten düşmenin canı (düşülen metre). */
export const fallDamage = (h: number) => (h <= LIFE.fallFrom ? 0 : Math.min(LIFE.hitMax, Math.round((h - LIFE.fallFrom) * LIFE.fallPerMeter)));

/** Arabanın çarpmasının canı (arabanın hızı, m/sn). */
export const carHitDamage = (v: number) => (v <= LIFE.carHitSpeed ? 0 : Math.min(LIFE.hitMax, Math.round((v - LIFE.carHitSpeed) * LIFE.carHitPerMs)));

/** Cüzdan işlemi: tutar, açıklama, ikon (Tabler/emoji yerine kısa emoji) ve an. */
export interface MoneyTx {
  amount: number;
  reason: string;
  icon: string;
  at: number;
}

/** Cüzdan paneli: bakiye, bugünkü kazanç ve harcama, son işlemler. */
export interface WalletView {
  balance: number;
  earned: number;
  spent: number;
  history: MoneyTx[];
}

/** Para gösterimi: "2.500 ₺". */
export const lira = (n: number) => `${Math.round(n).toLocaleString("tr-TR")} ₺`;
