// Tarayıcıdan ana adrese gelen için giriş ekranı: Discord ile giriş ya da isimle misafir. Seçim yapılınca
// kapanır; Discord seçilirse sayfa Discord'un onay ekranına gider (dönüşte çerezle doğrudan girilir).

export type LandingChoice = { kind: "discord" } | { kind: "guest"; name: string };

export function showLanding(opts: { discord: boolean; guests: boolean; failed: boolean; name: string }): Promise<LandingChoice> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "landing";
    root.innerHTML = `
      <div class="landing-card">
        <div class="landing-logo">🌍</div>
        <h1>GAP Dünyası</h1>
        <p class="landing-sub">Arkadaşlarınla aynı dünyada: sinema, halı saha, kahvehane, mahallede kendi evin.</p>
        ${opts.failed ? `<p class="landing-err">Discord girişi tamamlanamadı, tekrar dene.</p>` : ""}
        ${opts.discord ? `<button class="landing-discord" type="button">Discord ile giriş yap</button>` : ""}
        ${opts.discord && opts.guests ? `<div class="landing-or"><span>ya da</span></div>` : ""}
        ${opts.guests ? `
          <form class="landing-guest">
            <input name="name" maxlength="24" placeholder="Adın" autocomplete="nickname" />
            <button type="submit">Misafir olarak gir</button>
          </form>
          <p class="landing-note">Misafirler gezip oynayabilir; XP, ev ve kıyafet kaydı için Discord ile gir.</p>` : ""}
      </div>`;
    document.body.append(root);
    const done = (c: LandingChoice) => {
      root.remove();
      resolve(c);
    };
    root.querySelector<HTMLButtonElement>(".landing-discord")?.addEventListener("click", () => done({ kind: "discord" }));
    const form = root.querySelector<HTMLFormElement>(".landing-guest");
    if (form) {
      const input = form.querySelector("input")!;
      input.value = opts.name;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        done({ kind: "guest", name: input.value.trim() });
      });
      if (!opts.discord) input.focus();
    }
  });
}
