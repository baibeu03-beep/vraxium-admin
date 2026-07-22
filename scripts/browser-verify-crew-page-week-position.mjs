/**
 * 크루 페이지(front :3001) 렌더 검증 — 현재 주차 override 가 **화면에 그려진 텍스트**로 보이는지.
 *
 * 실측으로 확인된 렌더 지점(2026-07-22):
 *   · .info-badge.role      = 그 주차 클래스 배지  ← weeklyCardMeta.roleLabel (주차 핀)
 *   · .info-item.part       = 그 주차 소속 파트    ← weeklyCardMeta.partName
 *   · .detail-row (사이드바) = "· {part} /{등급}"  ← /api/profile (현재 시점, 주차 override 반영)
 *   · .activity-line        = 시즌 단위 구간       ← 3주룰이라 1주 override 로 안 바뀜(정상)
 *
 *   READ-ONLY. 사전조건: admin :3000, front :3001, override 행 존재.
 *   Usage: node scripts/browser-verify-crew-page-week-position.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try { ({ chromium } = rq("playwright-core")); } catch { ({ chromium } = rq("playwright")); }
const { createClient } = rq("@supabase/supabase-js");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const FRONT = "http://localhost:3001";
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const CODE_LABEL = { regular: "정규", advanced_agent: "심화(에이전트)", advanced_part_leader: "심화(파트장)" };
// 사이드바는 등급을 "(" 앞부분만 표시한다(기존 UI 규칙) — "심화(파트장)" → "심화", "정규" → "일반".
const SIDEBAR_LABEL = { regular: "일반", advanced_agent: "심화", advanced_part_leader: "심화" };
const ORG_PAGE = { encre: "-ec", phalanx: "-px", oranke: "" };

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  const { data: ovr } = await sb.from("cluster4_team_week_position_overrides")
    .select("user_id,organization,raw_team,raw_part,position_code,week_start_date")
    .order("updated_at", { ascending: false }).limit(6);
  if (!ovr?.length) { console.log("override 없음 — abort"); process.exit(1); }

  // 관측 유효 = override 클래스가 현재 멤버십 유도값과 다른 사람(같으면 어느 SoT 든 값이 같아 무의미).
  let target = null;
  for (const o of ovr) {
    const { data: p } = await sb.from("user_profiles").select("display_name,role").eq("user_id", o.user_id).maybeSingle();
    const { data: m } = await sb.from("user_memberships").select("membership_level").eq("user_id", o.user_id).eq("is_current", true).maybeSingle();
    const derivedAdv = p?.role === "part_leader" || (m?.membership_level ?? "").startsWith("심화");
    if (derivedAdv !== (o.position_code !== "regular")) {
      target = { ...o, name: p?.display_name, memLevel: m?.membership_level, role: p?.role };
      break;
    }
  }
  if (!target) { console.log("override==멤버십 인 행뿐 — 관측 불가. abort"); process.exit(1); }

  const suffix = ORG_PAGE[target.organization] ?? "";
  const url = `${FRONT}/cluster-4-card${suffix}?demoUserId=${target.user_id}`;
  console.log(`대상: ${target.name} — override ${target.raw_part}/${target.position_code}`);
  console.log(`  (현재 멤버십: level=${target.memLevel} role=${target.role} → 유도=${target.role === "part_leader" || (target.memLevel ?? "").startsWith("심화") ? "심화" : "정규"})`);
  console.log(`브라우저: ${url}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 1400 } })).newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 카드 메타(weekly-cards fetch) 도착까지 배지가 채워지길 기다린다.
    await page.waitForFunction(() => {
      const b = document.querySelector(".info-badge.role");
      return b && b.textContent.trim() !== "" && b.textContent.trim() !== "-";
    }, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const dom = await page.evaluate(() => ({
      badge: document.querySelector(".info-badge.role")?.textContent?.trim() ?? null,
      part: document.querySelector(".info-item.part")?.textContent?.trim() ?? null,
      detailRows: [...document.querySelectorAll(".detail-row")].map((el) => el.innerText.replace(/\s+/g, " ").trim()),
      activityLines: [...document.querySelectorAll(".activity-line")].map((el) => el.innerText.replace(/\n/g, " | ").trim()),
    }));

    console.log(`  렌더: info-badge.role="${dom.badge}"  info-item.part="${dom.part}"`);
    ck("① 주차 클래스 배지 == override", dom.badge === CODE_LABEL[target.position_code],
      `"${dom.badge}" 기대 "${CODE_LABEL[target.position_code]}"`);
    ck("② 주차 소속 파트 == override", (dom.part ?? "").includes(target.raw_part ?? ""),
      `"${dom.part}" 기대 "${target.raw_part}"`);

    // 사이드바 인적사항 "· {part} /{등급}" — /api/profile 경유(현재 시점 + 주차 override).
    const sideRow = dom.detailRows.find((r) => r.includes("/"));
    console.log(`  렌더: 사이드바 인적사항 = "${sideRow}"`);
    ck("③ 사이드바 소속 파트 == override", (sideRow ?? "").includes(target.raw_part ?? ""), `"${sideRow}"`);
    ck("③ 사이드바 등급 == override", (sideRow ?? "").includes(SIDEBAR_LABEL[target.position_code]),
      `"${sideRow}" 기대 포함 "${SIDEBAR_LABEL[target.position_code]}"`);

    // 시즌 구간은 3주룰이라 1주 override 로 안 바뀐다 — 정보성 출력(단언 아님).
    console.log("  · 시즌 활동 구간(3주룰 — 1주 override 로 안 바뀌는 것이 정상):");
    for (const l of dom.activityLines) console.log(`      ${l}`);
  } finally {
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
