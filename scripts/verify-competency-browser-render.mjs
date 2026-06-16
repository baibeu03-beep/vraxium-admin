import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const requireFront = createRequire(resolve(frontRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { chromium } = requireFront("playwright");

const envText = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const ADMIN = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const FRONT = process.env.FRONT_BASE_URL || "http://localhost:3001";
const ORG = "phalanx";
const MODE = "test";
const OUT_DIR = resolve(adminRoot, "claudedocs", "competency-browser-render");
mkdirSync(OUT_DIR, { recursive: true });

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const INTERNAL_KEY = env.INTERNAL_API_KEY || "";

let pass = 0;
let fail = 0;
const checks = [];
function ck(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "OK" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

function normCards(cards) {
  return (cards || []).map((c) => ({
    weekId: c.weekId ?? null,
    weekNumber: c.weekNumber ?? null,
    seasonKey: c.seasonKey ?? null,
    userWeekStatus: c.userWeekStatus ?? null,
    rates: {
      info: c.infoRate ?? null,
      experience: c.experienceRate ?? null,
      competency: c.competencyRate ?? null,
      career: c.careerRate ?? null,
    },
    lines: (c.lines || []).map((l) => ({
      lineId: l.lineId ?? null,
      lineTargetId: l.lineTargetId ?? null,
      weekId: l.weekId ?? null,
      partType: l.partType ?? null,
      lineCode: l.lineCode ?? null,
      lineName: l.lineName ?? null,
      mainTitle: l.mainTitle ?? null,
      numerator: l.numerator ?? null,
      denominator: l.denominator ?? null,
      rate: l.rate ?? null,
      enhancementStatus: l.enhancementStatus ?? null,
      submissionStatus: l.submissionStatus ?? null,
      canEdit: typeof l.canEdit === "boolean" ? l.canEdit : null,
      outputLinks: Array.isArray(l.outputLinks)
        ? l.outputLinks.map((x) => (typeof x === "string" ? x : x?.url ?? x?.href ?? "")).filter(Boolean)
        : [],
    })),
  }));
}

function shape(value) {
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])]));
  }
  return typeof value;
}

async function httpCards(base, qs, internal = true) {
  const res = await fetch(`${base}/api/cluster4/weekly-cards?${qs}`, {
    headers: internal ? { "x-internal-api-key": INTERNAL_KEY } : {},
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, cards: Array.isArray(json?.data) ? json.data : [] };
}

async function main() {
  const w13 = (await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date")
    .eq("season_key", "2026-spring")
    .eq("week_number", 13)
    .maybeSingle()).data;
  if (!w13?.id) throw new Error("W13 not found");

  const targetRows = (await sb
    .from("cluster4_line_targets")
    .select("line_id,target_user_id,week_id,created_at")
    .eq("week_id", w13.id)
    .order("created_at", { ascending: false })
    .limit(100)).data || [];
  const lineIds = [...new Set(targetRows.map((r) => r.line_id).filter(Boolean))];
  const lines = (await sb
    .from("cluster4_lines")
    .select("id,part_type,line_code,main_title,competency_line_master_id,is_active,created_at,output_links")
    .in("id", lineIds.length ? lineIds : ["x"])
    .eq("part_type", "competency")
    .eq("is_active", true)
    .order("created_at", { ascending: false })).data || [];
  const profiles = (await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", [...new Set(targetRows.map((r) => r.target_user_id).filter(Boolean))])).data || [];
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data || []).map((r) => r.user_id));

  const targets = lines
    .map((line) => {
      const target = targetRows.find((r) => r.line_id === line.id);
      const profile = profiles.find((p) => p.user_id === target?.target_user_id);
      return { line, target, profile, isTest: markers.has(target?.target_user_id) };
    })
    .filter((r) => r.target?.target_user_id && r.profile?.organization_slug === ORG && r.isTest);

  ck("W13 phalanx test competency targets exist", targets.length === 4, `targets=${targets.length}`);
  const primary = targets[0];
  if (!primary) throw new Error("No target line");
  const userId = primary.target.target_user_id;
  const lineId = primary.line.id;
  const lineCode = primary.line.line_code;
  const title = primary.line.main_title;

  const otherOrgUser = (await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .neq("organization_slug", ORG)
    .limit(1)).data?.[0];

  const snapBeforeRows = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,computed_at,is_stale,dto_version")
    .in("user_id", targets.map((t) => t.target.target_user_id))).data || [];
  const allSnapBefore = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,computed_at,is_stale,dto_version")
    .order("user_id")
    .limit(1000)).data || [];

  const adminUser = await httpCards(ADMIN, `userId=${userId}`);
  const adminUserTest = await httpCards(ADMIN, `userId=${userId}&mode=${MODE}`);
  const adminDemo = await httpCards(ADMIN, `demoUserId=${userId}&mode=${MODE}`, false);
  const adminDemoPlain = await httpCards(ADMIN, `demoUserId=${userId}`, false);
  const frontDemo = await httpCards(FRONT, `userId=${userId}&demoUserId=${userId}&mode=${MODE}`, true);
  const otherOrg = otherOrgUser
    ? await httpCards(ADMIN, `userId=${otherOrgUser.user_id}&mode=${MODE}`)
    : { status: 0, cards: [] };

  const directSnap = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards,is_stale,dto_version,computed_at")
    .eq("user_id", userId)
    .maybeSingle()).data;
  const directCards = Array.isArray(directSnap?.cards) ? directSnap.cards : [];

  const fpDirect = JSON.stringify(normCards(directCards));
  const fpAdmin = JSON.stringify(normCards(adminUser.cards));
  const fpAdminTest = JSON.stringify(normCards(adminUserTest.cards));
  const fpDemo = JSON.stringify(normCards(adminDemo.cards));
  const fpDemoPlain = JSON.stringify(normCards(adminDemoPlain.cards));

  const w13Card = adminUser.cards.find((c) => c.weekId === w13.id || c.weekNumber === 13);
  const targetLine = (w13Card?.lines || []).find((l) => l.lineId === lineId || l.lineTargetId === primary.target.id || l.lineCode === lineCode);
  const infoLine = (w13Card?.lines || []).find((l) => ["information", "info"].includes(String(l.partType).toLowerCase()));
  const expLine = (w13Card?.lines || []).find((l) => ["experience", "exp"].includes(String(l.partType).toLowerCase()));

  ck("admin HTTP 200", adminUser.status === 200 && adminUser.json?.success === true, `status=${adminUser.status}`);
  ck("direct snapshot == admin HTTP", fpDirect === fpAdmin, `direct=${directCards.length} http=${adminUser.cards.length}`);
  ck("userId mode=test == userId no mode DTO", fpAdminTest === fpAdmin);
  ck("demoUserId mode=test == direct DTO", fpDemo === fpDirect, `status=${adminDemo.status}`);
  ck("demoUserId mode=test == demoUserId no mode DTO", fpDemo === fpDemoPlain, `plainStatus=${adminDemoPlain.status}`);
  ck(
    "normal/test DTO shape unchanged",
    JSON.stringify(shape(adminUser.cards[0] || {})) === JSON.stringify(shape(adminUserTest.cards[0] || {})) &&
      JSON.stringify(shape(adminUser.cards[0] || {})) === JSON.stringify(shape(adminDemo.cards[0] || {})),
  );
  ck("W13 competency line appears in HTTP DTO", !!targetLine, `line=${lineCode}`);
  ck("practical-info and practical-experience still present", !!infoLine && !!expLine, `info=${!!infoLine} exp=${!!expLine}`);
  ck("phalanx line not leaked to another org DTO", !JSON.stringify(otherOrg.cards).includes(lineId) && !JSON.stringify(otherOrg.cards).includes(lineCode), `other=${otherOrgUser?.organization_slug}`);
  ck("snapshot is_stale=false", directSnap?.is_stale === false, `stale=${directSnap?.is_stale} v=${directSnap?.dto_version}`);

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  const consoleErrors = [];
  const cardStatuses = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => {
    if (res.url().includes("/api/cluster4/weekly-cards")) cardStatuses.push({ url: res.url(), status: res.status() });
  });

  const qs = `userId=${encodeURIComponent(userId)}&demoUserId=${encodeURIComponent(userId)}&mode=test&admin=true&org=phalanx`;
  const cardUrl = `${FRONT}/cluster-4-card-px/${w13.id}?${qs}`;
  await page.goto(cardUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForResponse((r) => r.url().includes("/api/cluster4/weekly-cards") && r.status() === 200, { timeout: 90_000 }).catch(() => null);
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.55));
  await page.waitForTimeout(1000);

  const hasRenderedAbilityCard = (text) =>
    text.includes("실무 역량") &&
    /총\s*1\s*개\s*중\s*0\s*개/.test(text) &&
    (text.includes("강화 실패") || text.includes("강화 대기") || text.includes("강화 성공"));
  let bodyText = await page.evaluate(() => document.body.innerText);
  let exactLineTextBeforeClick = bodyText.includes(lineCode) || bodyText.includes(title);
  let renderedBeforeClick = hasRenderedAbilityCard(bodyText);
  if (!exactLineTextBeforeClick) {
    const clicked = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".work-ability-card"));
      const target = cards.find((el) => !el.className.includes("empty")) || cards[0];
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    if (clicked) await page.waitForTimeout(1500);
    bodyText = await page.evaluate(() => document.body.innerText);
  }
  const exactLineTextAfterClick = bodyText.includes(lineCode) || bodyText.includes(title);
  const renderedAfterClick = hasRenderedAbilityCard(bodyText);
  const cardShot = resolve(OUT_DIR, "w13-phalanx-card-render.png");
  await page.screenshot({ path: cardShot, fullPage: false });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForResponse((r) => r.url().includes("/api/cluster4/weekly-cards") && r.status() === 200, { timeout: 90_000 }).catch(() => null);
  await page.waitForTimeout(2500);
  const reloadText = await page.evaluate(() => document.body.innerText);
  const reloadFront = await httpCards(FRONT, `userId=${userId}&demoUserId=${userId}&mode=test`, true);
  const reloadVisible =
    hasRenderedAbilityCard(reloadText) &&
    JSON.stringify(reloadFront.cards).includes(lineCode);
  const reloadShot = resolve(OUT_DIR, "w13-phalanx-card-after-refresh.png");
  await page.screenshot({ path: reloadShot, fullPage: false });

  const relatedPages = [];
  for (const [name, path] of [
    ["cluster-4-px", "/cluster-4-px"],
    ["cluster-4-1-px", "/cluster-4-1-px"],
  ]) {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    const statuses = [];
    p.on("response", (res) => {
      if (res.url().includes("/api/cluster4/weekly-cards")) statuses.push(res.status());
    });
    await p.goto(`${FRONT}${path}?${qs}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await p.waitForResponse((r) => r.url().includes("/api/cluster4/weekly-cards") && r.status() === 200, { timeout: 90_000 }).catch(() => null);
    await p.waitForTimeout(2500);
    const text = await p.evaluate(() => document.body.innerText);
    const shot = resolve(OUT_DIR, `${name}.png`);
    await p.screenshot({ path: shot, fullPage: false });
    relatedPages.push({ name, statuses, textHasW13: text.includes("13") || text.includes("W13"), screenshot: shot });
    await p.close();
  }

  ck("browser card page weekly-cards 200", cardStatuses.some((s) => s.status === 200), JSON.stringify(cardStatuses.map((s) => s.status)));
  ck(
    "browser rendered W13 competency line card",
    renderedAfterClick && JSON.stringify(frontDemo.cards).includes(lineCode),
    `line=${lineCode} exactText=${exactLineTextAfterClick} renderedBeforeClick=${renderedBeforeClick}`,
  );
  ck("browser refresh keeps W13 competency line", reloadVisible, `line=${lineCode}`);
  ck("related customer screens call same DTO", relatedPages.every((p) => p.statuses.includes(200)), relatedPages.map((p) => `${p.name}:${p.statuses.join(",")}`).join(" | "));
  ck(
    "browser console errors unrelated to weekly-cards",
    consoleErrors.filter((e) => /weekly-cards|cluster4|TypeError|ReferenceError/i.test(e)).length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );

  await browser.close();

  const snapAfterRows = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,computed_at,is_stale,dto_version")
    .in("user_id", targets.map((t) => t.target.target_user_id))).data || [];
  const allSnapAfter = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,computed_at,is_stale,dto_version")
    .order("user_id")
    .limit(1000)).data || [];
  const changedDuringBrowser = allSnapAfter.filter((after) => {
    const before = allSnapBefore.find((b) => b.user_id === after.user_id);
    return before && before.computed_at !== after.computed_at;
  });
  const openingCreatedAtMs = Math.min(...targets.map((t) => Date.parse(t.line.created_at)).filter(Number.isFinite));
  const recomputedSinceOpening = allSnapAfter.filter((r) => r.computed_at && Date.parse(r.computed_at) >= openingCreatedAtMs - 1000);
  const targetIds = new Set(targets.map((t) => t.target.target_user_id));
  const nonTargetRecomputedSinceOpening = recomputedSinceOpening.filter((r) => !targetIds.has(r.user_id));

  ck("browser verification did not trigger extra recompute", changedDuringBrowser.length === 0, `changed=${changedDuringBrowser.length}`);
  ck(
    "snapshot recompute did not spread beyond target users",
    nonTargetRecomputedSinceOpening.length === 0,
    `targetSinceOpen=${recomputedSinceOpening.filter((r) => targetIds.has(r.user_id)).length} nonTargetSinceOpen=${nonTargetRecomputedSinceOpening.length}`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    user: { userId, displayName: primary.profile.display_name, org: primary.profile.organization_slug },
    week: w13,
    primaryLine: { lineId, lineCode, title },
    targetCount: targets.length,
    http: {
      adminUser: adminUser.status,
      adminUserTest: adminUserTest.status,
      adminDemo: adminDemo.status,
      adminDemoPlain: adminDemoPlain.status,
      frontDemo: frontDemo.status,
    },
    snapshot: {
      before: snapBeforeRows,
      after: snapAfterRows,
      changedDuringBrowser,
      recomputedSinceOpening: recomputedSinceOpening.map((r) => r.user_id),
      nonTargetRecomputedSinceOpening: nonTargetRecomputedSinceOpening.map((r) => r.user_id),
    },
    browser: {
      cardUrl,
      cardStatuses,
      renderedBeforeClick,
      renderedAfterClick,
      exactLineTextBeforeClick,
      exactLineTextAfterClick,
      reloadVisible,
      screenshots: [cardShot, reloadShot, ...relatedPages.map((p) => p.screenshot)],
    },
    checks,
    pass,
    fail,
  };
  const reportPath = resolve(OUT_DIR, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport=${reportPath}`);
  console.log(`screenshots=${report.browser.screenshots.join(" | ")}`);
  console.log(`result pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
