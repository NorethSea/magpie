// Run with Node's test runner and Playwright on the module path; see README.md.
// What was left over time (#651): under an account's meters on the Usage
// page, a line a window from magpie's readings — broken where the 5-hour
// window started again — a dashed even burn from each window's start to its
// reset, and an upright line at now. One pick in the allowances' head, the
// app's own menu, turns every card at once: "2 days" / "Cycle", or "Off"
// (ARNO on Discord: the curves made the cards cluttered), which draws no
// curve on any card, the tray's thin line included; each account can pick
// an earlier recorded cycle in Cycle mode. The global pick is remembered
// across a reload, and no click moves the page. Several accounts on a card
// are set apart by a rule, a curve's legend before the next one too. An
// account with no readings has no curve. The tray's card has a thin line of
// its first window's cycle, with no now line (#1601), and a click into the
// tray's list rings nothing.
// English and Chinese, light and dark; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { chromium, webkit } = require("playwright");

const assets = process.env.MAGPIE_QUOTA_ASSETS || path.resolve(__dirname, "../assets");
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

function fixtures(now) {
  const r5 = now + 2 * H, rw = now + 3 * 24 * H;
  const quotas = [
    { provider: "codex", name: "Codex", icon: "openai", plan: "Plus", user: "a@x.com", windows: [
      { name: "5 hours", used: 40, resetsAt: iso(r5) },
      { name: "Weekly", used: 30, resetsAt: iso(rw) },
    ] },
    { provider: "codex", name: "Codex", icon: "openai", plan: "Pro", user: "b@x.com", windows: [
      { name: "5 hours", used: 10, resetsAt: iso(r5) },
    ] },
    { provider: "kimi", name: "Kimi", icon: "kimi-color", windows: [{ name: "Weekly", used: 10, resetsAt: iso(rw) }] },
  ];
  const five = [], week = [];
  // the 5-hour window before the last reset, then this one
  for (let m = 0; m <= 180; m += 30) five.push({ at: iso(r5 - 10 * H + m * 60e3), left: 100 - m / 3, start: iso(r5 - 10 * H), resetsAt: iso(r5 - 5 * H) });
  for (let m = 0; m <= 180; m += 30) five.push({ at: iso(r5 - 5 * H + m * 60e3), left: 100 - m / 3, start: iso(r5 - 5 * H), resetsAt: iso(r5) });
  for (let h = 90; h >= 0; h -= 6) week.push({ at: iso(now - h * H), left: 70 + h / 9, start: iso(rw - 168 * H), resetsAt: iso(rw) });
  const history = [
    { provider: "codex", user: "a@x.com", lines: [{ name: "5 hours", points: five }, { name: "Weekly", points: week }] },
    { provider: "codex", user: "b@x.com", lines: [{ name: "5 hours", points: five.slice(-4) }] },
  ];
  return { quotas, history };
}

const cycleWords = {
  en: { choose: "Choose a recorded cycle", past: "Past cycle", missing: "No readings in this cycle", duration: "Recorded duration:", reading: "Last reading", ended: "Cycle ended" },
  zh: { choose: "选择已记录的周期", past: "历史周期", missing: "本周期无记录", duration: "已记录时长：", reading: "最后采样于", ended: "周期结束于" },
  "zh-TW": { choose: "選擇已記錄的週期", past: "歷史週期", missing: "此週期無記錄", duration: "已記錄時長：", reading: "最後取樣於", ended: "週期結束於" },
  ja: { choose: "記録されたサイクルを選択", past: "過去のサイクル", missing: "このサイクルの記録なし", duration: "記録された期間:", reading: "最終記録:", ended: "サイクル終了:" },
  de: { choose: "Aufgezeichneten Zyklus wählen", past: "Vergangener Zyklus", missing: "Keine Messwerte in diesem Zyklus", duration: "Erfasste Dauer:", reading: "Letzte Messung:", ended: "Zyklusende:" },
};
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const [lang, w] of Object.entries(cycleWords)) {
    test(`${engine} ${lang}: recorded quota cycles include manual and unscheduled resets`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const context = await browser.newContext({ viewport: { width: 440, height: 760 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const now = Date.now(), D = 24 * H;
      const data = fixtures(now);
      data.quotas[0].readAt = iso(now);
      data.quotas[0].windows[1].holds = { tokens: 100000, cost: 12, priced: true, used: 30, routed: { calls: 10, tokens: 30000, cost: 3.6 } };
      const point = (day, left, reset) => ({ at: iso(now + day * D), left, start: iso(now + (reset - 7) * D), resetsAt: iso(now + reset * D) });
      // An early manual reset, an official refill with the SAME deadline,
      // then an ordinary week. None is found by subtracting seven days
      // from today's deadline. Only the manual cycle has old 5-hour data.
      data.quotas[0].windows[1].resetsAt = iso(now + D);
      data.history[0].lines[1].points = [
        point(-16, 90, -10), point(-14, 20, -10),
        point(-13, 100, -6), point(-12, 70, -6),
        point(-11, 100, -6), point(-9, 30, -6),
        point(-5, 95, 1), point(-1 / 24, 65, 1),
      ];
      const shortReset = now - 12 * D + H;
      data.history[0].lines[0].points.unshift({ at: iso(now - 12 * D), left: 12, start: iso(shortReset - 5 * H), resetsAt: iso(shortReset) });
      const reads = [];
      const handler = serve(lang, "light", false, data);
      await page.route("**/*", (r) => { if (r.request().url().includes("/quotas/history")) reads.push(r.request().url()); return handler(r); });
      await page.goto("http://magpie.test/?view=usage");
      const card = page.locator('.subscription-card[data-key="codex"]');
      const curve = card.locator(".quota-curve").first();
      await curve.waitFor();
      assert.equal(await curve.locator("button.qc-range").count(), 1, "each account can choose a recorded cycle");
      assert.ok(reads.some((url) => new URL(url).searchParams.get("days") === "45"), "all retained history is requested");
      await card.locator(".quota-more").click();
      const other = card.locator(".quota-curve").nth(1);
      const otherAxis = await other.locator(".qc-axis").textContent();
      const currentAxis = await curve.locator(".qc-axis").textContent();
      const currentLegend = await curve.locator(".qc-key").allTextContents();
      const meters = card.locator(".quota-windows").first();
      const currentMeters = await meters.locator(".quota-n").allTextContents();
      assert.equal(await meters.locator(".quota-holds").count(), 1, "the current view keeps upstream's whole-window estimate");
      const otherMeters = await card.locator(".quota-windows").nth(1).locator(".quota-n").allTextContents();
      const pick = curve.getByRole("button", { name: w.choose });
      for (const [index, left] of [[1, 30], [2, 70], [3, 20]]) {
        const before = await page.locator("#view-usage").evaluate((v) => v.scrollTop);
        await pick.click();
        const items = page.locator(".sess-menu .pm-item");
        assert.equal(await items.count(), 4, "current + three observed cycles");
        const notes = await items.locator(".pm-note").allTextContents();
        assert.ok(notes.slice(1).every((note) => note.startsWith(w.duration)), "menu describes the observed duration, not the window's nominal name");
        assert.notEqual(notes[1], notes[2], "a regular week and an early reset have different lengths");
        await items.nth(index).click();
        assert.equal(await pick.textContent(), w.past);
        assert.equal(await meters.locator(".quota-holds").count(), 0, "today's whole-window estimate is not presented as a historical estimate");
        const hasShort = index === 2;
        assert.deepEqual(await curve.locator(".qc-key b").allTextContents(), hasShort ? ["12%", left + "%"] : [left + "%"], "the historical legend uses that cycle's final reading");
        assert.match(await meters.locator(".quota-n").nth(1).textContent(), new RegExp((100 - left) + "%"), "the weekly meter follows the historical selection");
        if (hasShort) assert.match(await meters.locator(".quota-n").first().textContent(), /88%/, "the 5-hour meter uses its last reading inside that cycle");
        else assert.equal(await meters.locator(".quota-n").first().textContent(), w.missing, "missing history never shows today's meter");
        assert.ok((await meters.locator(".quota-reset").allTextContents()).every((text) => text.startsWith(w.ended)), "historical dates aren't current countdowns");
        assert.ok((await card.locator(".quota-read").first().textContent()).includes(w.reading));
        assert.equal(await card.locator(".quota-autoreset").count(), 1, "only the other account retains current controls");
        assert.equal(await curve.locator("line.qc-now").count(), 0, "now is outside a completed cycle");
        assert.equal(await curve.locator("line.qc-even").count(), hasShort ? 2 : 1, "the historical even pace belongs to the selected cycle");
        assert.equal(await curve.locator("path.qc-line").count(), hasShort ? 2 : 1, "no fabricated short-window readings");
        assert.notEqual(await curve.locator(".qc-axis").textContent(), currentAxis);
        assert.equal(await other.locator(".qc-axis").textContent(), otherAxis, "another account stays on its own cycle");
        assert.deepEqual(await card.locator(".quota-windows").nth(1).locator(".quota-n").allTextContents(), otherMeters);
        assert.equal(await page.locator("#view-usage").evaluate((v) => v.scrollTop), before, "choosing a cycle doesn't scroll");
        const coords = await curve.locator("path.qc-line").first().getAttribute("d");
        assert.ok(!/NaN|Infinity/.test(coords), coords);
      }
      await meters.locator(".quota-n").nth(1).click();
      assert.match(await meters.locator(".quota-n").nth(1).textContent(), /20%/, "Left is also the selected cycle's historical value");
      assert.equal(await meters.locator(".quota-n").first().textContent(), w.missing);
      await meters.locator(".quota-n").nth(1).click();
      assert.match(await meters.locator(".quota-n").nth(1).textContent(), /80%/);
      await page.locator("#quotaTrend").click();
      await page.locator(".sess-menu .pm-item").nth(1).click();
      assert.deepEqual(await meters.locator(".quota-n").allTextContents(), currentMeters, "2 days restores current meters");
      await page.locator("#quotaTrend").click();
      await page.locator(".sess-menu .pm-item").nth(2).click();
      assert.match(await meters.locator(".quota-n").nth(1).textContent(), /80%/, "Cycle resumes the account's selected historical period");
      await card.locator(".quota-refresh").first().click();
      await page.waitForFunction(() => !document.querySelector(".quota-refresh.busy"));
      assert.equal(await pick.textContent(), w.past, "a refresh preserves the selected historical cycle");
      assert.deepEqual(await curve.locator(".qc-key b").allTextContents(), ["20%"]);
      await pick.click();
      await page.locator(".sess-menu .pm-item").first().click();
      assert.equal(await curve.locator(".qc-axis").textContent(), currentAxis);
      assert.deepEqual(await curve.locator(".qc-key").allTextContents(), currentLegend);
      assert.deepEqual(await meters.locator(".quota-n").allTextContents(), currentMeters, "returning to this cycle restores today's meters");
      assert.equal(await meters.locator(".quota-holds").count(), 1, "returning to this cycle restores upstream's whole-window estimate");
      assert.deepEqual(await page.evaluate(() => ({ page: document.documentElement.scrollWidth > innerWidth, cards: [...document.querySelectorAll(".subscription-card")].some((c) => c.scrollWidth > c.clientWidth + 1) })), { page: false, cards: false });
      assert.deepEqual(errors, []);
      if (process.env.ARTIFACT_DIR) {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await pick.click();
        await page.locator(".sess-menu .pm-item").nth(2).click();
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-quota-history.png`) });
      }
    });
  }
}

test("quota curve distinguishes fixed refills, rolling recovery and clock rounding", async () => {
  const source = await fs.readFile(path.join(assets, "app.js"), "utf8");
  const start = source.indexOf("function quotaCycleBreak(a, b) {");
  const end = source.indexOf("\n}\n", start);
  const check = vm.runInNewContext(source.slice(start, end + 2) + "; quotaCycleBreak");
  const at = Date.UTC(2026, 9, 1), reset = at + 7 * 24 * H;
  const a = { at, reset, left: 20 };
  for (const [name, gap, moved, left, want] of [
    ["fixed deadline refill", 60e3, 0, 100, true],
    ["rounded fixed refill", 10 * 60e3, 60e3, 100, true],
    ["manual restart", 60e3, 24 * H, 100, true],
    ["earlier official restart", 60e3, -24 * H, 100, true],
    ["normal expiry", 7 * 24 * H, 7 * 24 * H, 100, true],
    ["small correction", 60e3, 0, 24, false],
    ["clock rounding", 60e3, 60e3, 20, false],
    ["rolling recovery", H, H, 80, false],
    ["fast rolling recovery", 60e3, 60e3, 80, false],
  ]) assert.equal(check(a, { at: at + gap, reset: reset + moved, left }), want, name);
});

function serve(lang, theme, panel, data) {
  const settings = { theme, lang, tray: "panel", quotaLeft: false, currency: "usd" };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:${!panel}};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings });
    if (url.pathname === "/api/settings") return json(settings);
    if (url.pathname === "/api/settings/quota-left") { settings.quotaLeft = route.request().postDataJSON().on; return json(settings); }
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/usage/quotas") return json(data.quotas);
    if (url.pathname === "/api/usage/quotas/history") return json(data.history);
    if (url.pathname === "/api/usage") return json({ calls: 0, input: 0, output: 0, cost: 0, agents: [], accounts: [], models: [], series: [], days: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], models: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

const words = {
  en: { head: "Left over time", two: "2 days", cycle: "Cycle", off: "Off", trend: (r) => "Trends: " + r, five: "5 hours", week: "Weekly", dashes: /Dashed: an even pace/ },
  zh: { head: "剩余额度走势", two: "2 天", cycle: "本周期", off: "关闭", trend: (r) => "走势：" + r, five: "5 小时", week: "每周", dashes: /虚线：匀速用量/ },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    test(`${engine} ${lang}: quota cards draw what was left over time`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      const pages = [];
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          for (const [name, p] of pages) await p.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-quota-curve-${name}.png`) });
        }
        await browser.close();
      });
      const errors = [];
      const data = fixtures(Date.now());
      const open = async (name, url, theme, viewport) => {
        const page = await (await browser.newContext({ viewport, reducedMotion: "reduce" })).newPage();
        pages.push([name, page]);
        page.setDefaultTimeout(5000);
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, theme, url.includes("mode=panel"), data));
        await page.goto(url);
        return page;
      };

      const strokes = {};
      for (const theme of ["light", "dark"]) {
        const page = await open(theme, "http://magpie.test/?view=usage", theme, { width: 900, height: 620 });
        const card = page.locator(".subscription-card", { hasText: "Codex" });
        const curve = card.locator(".quota-curve").first();
        await curve.waitFor();
        assert.equal(await curve.locator(".qc-head > span").first().textContent(), w.head);
        // the range is picked once, in the allowances' head, not on every card
        const pick = page.locator("#quotaHead #quotaTrend");
        assert.equal(await pick.textContent(), w.trend(w.cycle), "Cycle first");
        assert.equal(await page.locator(".quota-curve .segs, .quota-curve button:not(.qc-range), .quota-curve select").count(), 0, "only the account's cycle picker on a card");
        assert.equal(await curve.locator(".qc-range").textContent(), w.cycle);
        // a line a window, now; the 5-hour window, a comb over the week's
        // cycle, faint and without its upright even burn
        assert.equal(await curve.locator("path.qc-line").count(), 2);
        assert.equal(await curve.locator("line.qc-even").count(), 1);
        assert.match(await curve.getAttribute("title"), w.dashes, "hovering the plot says what the dashes are");
        assert.equal(await curve.locator("path.qc-line.qc-short").getAttribute("data-name"), "5 hours");
        assert.equal(await curve.locator("line.qc-now").count(), 1);
        const five = await curve.locator('path.qc-line[data-name="5 hours"]').getAttribute("d");
        assert.equal((five.match(/M/g) || []).length, 2, "the 5-hour line breaks where its window started again: " + five);
        const legend = await curve.locator(".qc-key").allTextContents();
        assert.deepEqual(legend, [w.five + "40%", w.week + "70%"]);
        assert.equal(await page.locator(".subscription-card", { hasText: "Kimi" }).locator(".quota-curve").count(), 0, "no readings, no curve");
        // the colours are the theme's chart colours, nothing outside the card
        strokes[theme] = await curve.locator("path.qc-line").first().evaluate((e) => getComputedStyle(e).stroke);
        const c1 = await page.evaluate(() => { const s = document.createElement("i"); s.style.color = "var(--c1)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; });
        assert.equal(strokes[theme], c1);
        const box = await card.boundingBox(), plot = await curve.locator(".qc-plot").boundingBox();
        assert.ok(plot.x >= box.x && plot.x + plot.width <= box.x + box.width + 0.5, "the plot fits its card");
        const left = await curve.evaluate((e) => [...e.querySelectorAll("*")].filter((x) => parseFloat(getComputedStyle(x).borderLeftWidth) > 0).length);
        assert.equal(left, 0, "no left borders");

        if (theme === "light") {
          // several accounts: the next one is set apart from a curve's legend
          await card.locator(".quota-more").click();
          const second = card.locator(".subscription-account", { hasText: "b@x.com" });
          // (after the curve, a Codex account's Auto-use row, #719, then its
          // Use credits row, which closes its section)
          assert.deepEqual(await second.evaluate((e) => [e.previousElementSibling.previousElementSibling.previousElementSibling.className, e.previousElementSibling.previousElementSibling.className, e.previousElementSibling.className]), ["quota-curve", "quota-autoreset", "quota-credits on"]);
          assert.notEqual(await second.evaluate((e) => getComputedStyle(e).borderTopStyle), "none", "a rule between the accounts");
          const choose = async (name) => {
            await pick.click();
            const items = page.locator(".sess-menu .pm-item");
            assert.deepEqual(await items.locator(".pm-name").allTextContents(), [w.off, w.two, w.cycle]);
            await items.filter({ hasText: name }).click();
          };
          // 2 days: the range turns, the page doesn't move, the pick is kept
          const scroller = await page.evaluate(() => { const s = document.scrollingElement; s.scrollTop = 40; return s.scrollTop; });
          const before = await curve.locator(".qc-axis").textContent();
          await choose(w.two);
          assert.equal(await pick.textContent(), w.trend(w.two));
          assert.equal(await curve.locator(".qc-range").textContent(), w.two);
          assert.notEqual(await curve.locator(".qc-axis").textContent(), before);
          assert.notEqual(await curve.locator('path.qc-line[data-name="5 hours"]').getAttribute("d"), five);
          assert.equal(await curve.locator("line.qc-even").count(), 2, "over two days the 5-hour window has its even burn");
          assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), scroller, "the click moved the page");
          assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaRange")), "2d");
          // Off: no card draws a curve, the pick stays where it was, kept
          // across a reload; back on, the curves come back
          const at = (await pick.boundingBox()).y;
          await choose(w.off);
          assert.equal(await page.locator(".quota-curve").count(), 0);
          assert.equal(await pick.textContent(), w.trend(w.off));
          assert.equal((await pick.boundingBox()).y, at, "the pick moved");
          assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), scroller, "the click moved the page");
          assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaRange")), "off");
          await page.reload();
          await page.locator(".subscription-card", { hasText: "Codex" }).locator(".quota-windows").first().waitFor();
          assert.equal(await page.locator(".quota-curve").count(), 0, "Off is kept across a restart");
          assert.equal(await pick.textContent(), w.trend(w.off));
          await choose(w.cycle);
          await curve.waitFor();
          assert.equal(await page.evaluate(() => localStorage.getItem("magpie.quotaRange")), "cycle");
        }
      }
      assert.notEqual(strokes.light, strokes.dark, "dark has its own line colour");

      // the tray: a thin line of the 5-hour window's cycle, across the card
      const panel = await open("panel", "http://magpie.test/?mode=panel", "dark", { width: 440, height: 640 });
      await panel.locator('#ptabs [data-ptab="usage"]').click();
      const pcard = panel.locator(".pq-card", { hasText: "a@x.com" });
      const spark = pcard.locator(".pq-spark");
      await spark.waitFor();
      assert.equal(await spark.locator("path.qc-line").count(), 1);
      assert.equal((((await spark.locator("path.qc-line").getAttribute("d")).match(/M/g)) || []).length, 1, "the current cycle only");
      assert.equal(await spark.locator("line.qc-even").count(), 1);
      // the line ends at now already; in 16px a dotted now line read as a
      // stray mark under the curve (#1601)
      assert.equal(await spark.locator("line.qc-now").count(), 0, "no now line in the thin spark");
      // measured in one go once drawn: the cards are drawn again when the
      // allowances read on opening the tab come back, and a card looked up
      // in one call and measured in the next could be the one taken out
      // (red under load, on main too)
      const { sb, cb } = await panel.waitForFunction(() => {
        const c = [...document.querySelectorAll("#panelQuota .pq-card")].find((c) => c.textContent.includes("a@x.com"));
        const s = c?.querySelector(".pq-spark");
        if (!s || !s.getBoundingClientRect().width) return null;
        const box = (e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; };
        return { sb: box(s), cb: box(c) };
      }).then((h) => h.jsonValue());
      assert.ok(sb.height <= 17 && sb.width > cb.width * 0.7, `thin and across the card: ${JSON.stringify(sb)}`);
      assert.equal(await panel.locator(".pq-card", { hasText: "Kimi" }).locator(".pq-spark").count(), 0);
      // a click into the list, then a key to scroll it, rings nothing: the
      // view takes focus only so the keys scroll it (#1601, WebKitGTK)
      // (after the spark is measured: the click focuses the window, whose
      // focus reloads and redraws the cards, so a card measured then can be
      // between two draws)
      await panel.mouse.click(220, 300);
      await panel.keyboard.press("ArrowDown");
      const ring = await panel.evaluate(() => { const a = document.activeElement, cs = getComputedStyle(a); return { view: a.classList.contains("view"), outline: cs.outlineStyle === "none" ? "none" : cs.outlineStyle + " " + cs.outlineWidth }; });
      assert.deepEqual(ring, { view: true, outline: "none" }, "the scrolled view shows no focus ring");
      // turned off in the window, the tray's line goes too, and stays gone
      const win = await panel.context().newPage();
      await win.route("**/*", serve(lang, "dark", false, data));
      // a page of magpie's origin, only for its storage: served as a 404
      // with no body, Chromium refused to open it (ERR_HTTP_RESPONSE_CODE_FAILURE)
      await win.route("http://magpie.test/blank", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
      await win.goto("http://magpie.test/blank");
      await win.evaluate(() => localStorage.setItem("magpie.quotaRange", "off"));
      await panel.waitForFunction(() => !document.querySelector(".pq-spark"));
      assert.ok(await pcard.locator(".pq-dial").count() > 0, "the card is still there");
      await panel.reload();
      await panel.locator('#ptabs [data-ptab="usage"]').click();
      await pcard.locator(".pq-dial").first().waitFor();
      assert.equal(await panel.locator(".pq-spark").count(), 0, "Off is kept in the tray");
      assert.deepEqual(errors, []);
    });
  }
}
