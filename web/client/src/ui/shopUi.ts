// Dükkân (yeme-içme): büyük ikonlu ürün kartları, karta tıklayınca sepete eklenir; altta sepet ve toplam, "Öde"
// ile tek seferde alınır, ürünler çantaya girer. Kartta etkisi yazar (açlık, enerji, süreli etki).
import { lira } from "../../../shared/economy";
import { INV, itemDef, type ItemId, type ShopId, SHOPS, useText } from "../../../shared/items";
import { el, Panel } from "./panel";

export class ShopUi {
  private panel: Panel;
  private shop: ShopId | null = null;
  private cart = new Map<ItemId, number>();
  private grid: HTMLDivElement;
  private foot: HTMLDivElement;
  private cartList: HTMLDivElement;
  private total: HTMLElement;
  private pay: HTMLButtonElement;
  private balance = 0;

  constructor(parent: HTMLElement, private a: { buy(shop: ShopId, cart: { id: ItemId; n: number }[]): void; closed(): void }) {
    this.panel = new Panel(parent, "", "shop-panel", "storefront");
    this.panel.onClose = () => a.closed();
    this.grid = el("div", "shop-grid", this.panel.body);
    this.foot = el("div", "shop-foot", this.panel.body);
    this.cartList = el("div", "shop-cart", this.foot);
    const right = el("div", "shop-pay", this.foot);
    this.total = el("b", "", right);
    this.pay = el("button", "shop-pay-btn", right, "Öde");
    this.pay.addEventListener("click", () => {
      if (!this.shop || !this.cart.size) return;
      this.a.buy(this.shop, [...this.cart].map(([id, n]) => ({ id, n })));
    });
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  open(shop: ShopId): void {
    const s = SHOPS[shop];
    this.shop = shop;
    this.cart.clear();
    this.panel.title = `${s.icon} ${s.name.toLocaleUpperCase("tr-TR")}`;
    this.grid.replaceChildren();
    for (const id of s.items as ItemId[]) {
      const d = itemDef(id)!;
      const card = el("button", "shop-card", this.grid);
      el("span", "shop-ic", card, d.icon);
      el("b", "", card, d.name);
      el("small", "shop-fx", card, useText(d));
      el("span", "shop-price", card, lira(d.price));
      const badge = el("i", "shop-badge", card);
      card.dataset.id = id;
      card.title = d.desc;
      card.addEventListener("click", () => this.add(id, 1));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.add(id, -1);
      });
      badge.dataset.id = id;
    }
    this.render();
    this.panel.open();
  }

  close(): void {
    this.panel.close();
  }

  setBalance(b: number): void {
    this.balance = b;
    if (this.isOpen) this.render();
  }

  /** Satın alındı (çanta güncellendi): sepet boşalır. */
  bought(): void {
    if (!this.cart.size) return;
    this.cart.clear();
    this.render();
  }

  private add(id: ItemId, d: number): void {
    const count = [...this.cart.values()].reduce((s, n) => s + n, 0);
    if (d > 0 && count >= INV.cartMax) return;
    const n = (this.cart.get(id) ?? 0) + d;
    if (n > 0) this.cart.set(id, n);
    else this.cart.delete(id);
    this.render();
  }

  private render(): void {
    let sum = 0;
    this.cartList.replaceChildren();
    if (!this.cart.size) el("span", "shop-empty", this.cartList, "Ürüne tıkla: sepete ekle · sağ tık: çıkar");
    for (const [id, n] of this.cart) {
      const d = itemDef(id)!;
      sum += d.price * n;
      const chip = el("button", "shop-chip", this.cartList, `${d.icon} ×${n}`);
      chip.title = "Bir tane çıkar";
      chip.addEventListener("click", () => this.add(id, -1));
    }
    for (const b of this.grid.querySelectorAll<HTMLElement>(".shop-badge")) {
      const n = this.cart.get(b.dataset.id as ItemId) ?? 0;
      b.textContent = n ? String(n) : "";
      b.classList.toggle("on", n > 0);
    }
    this.total.textContent = lira(sum);
    const short = sum > this.balance;
    this.total.classList.toggle("short", short);
    this.pay.disabled = !sum;
    this.pay.textContent = short ? "Bakiye yetmiyor" : sum ? `Öde ${lira(sum)}` : "Öde";
  }
}
