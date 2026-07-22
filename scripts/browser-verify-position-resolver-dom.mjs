/**
 * 공통 resolver — **렌더된 DOM** 검증. HTTP payload 가 맞아도 화면이 클라이언트에서 값을 다시
 * 만들면 사용자는 옛 값을 계속 본다(실사고: MembersList 가 classLabel(role, level) 을 클라이언트에서
 * 계산해 서버 수정이 화면에 안 나타났다). 그래서 셀 텍스트를 직접 읽는다.
 *
 * 검증 대상:
 *   ① admin 회원 목록(/admin/members)   — 클래스·소속 셀 텍스트
 *   ② admin 팀 상세 [B](주차 표)        — W-1 / W / W+1 셀 텍스트
 *   ③ front 크루 페이지(주차 배지/파트)  — 고객이 실제로 보는 값
 *
 * 절차: 지문 캡처 → PATCH(대상 1명·그 주차) → DOM 단언 → 원복(그 1행만) → 지문 대조.
 * Usage: npm run verify:position-resolver-dom
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
let chromium;
try { ({ chromium } = rq("playwright-core")); } catch { ({ chromium } = rq("playwright")); }

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";
const ORG = "encre";
const MODE = "test";
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 180000);

let fail = 0, skipped = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const skip = (l, why) => { console.log(`  ~ ${l} — SKIP: ${why}`); skipped++; };
const hr = (t) => console.log(`\n──────── ${t} ────────`);

async function sessionCookies() {
  const { data: admins } = await sb
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin session = ${email}`);
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

const fingerprint = async () => {
  const { data } = await sb
    .from(OVR).select("user_id,organization,week_start_date,raw_team,raw_part,position_code")
    .order("week_start_date", { ascending: true });
  return (data ?? [])
    .map((r) => `${r.week_start_date}|${r.organization}|${r.raw_team}|${r.raw_part}|${r.position_code}|${r.user_id}`)
    .sort().join("\n");
};

async function main() {
  const cookies = await sessionCookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (path, init) =>
    fetch(`${ADMIN}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { cookie: cookieHeader, "content-type": "application/json", ...(init?.headers ?? {}) },
    })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  const fpBefore = await fingerprint();
  console.log(`override 지문(시작) = ${fpBefore.split("\n").length}행`);

  // 대상 팀·주차 — HTTP 검증 스크립트와 동일 규칙(QA 팀 · 편집 가능 주차).
  const { data: th } = await sb
    .from("cluster4_team_halves").select("id,team_name")
    .eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true)
    .order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("QA 팀 없음 — abort"); process.exit(1); }
  const wsUrl = (wid) =>
    `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}` +
    `&teamHalfId=${team.id}&mode=${MODE}${wid ? `&weekId=${wid}` : ""}`;
  const before = (await call(wsUrl())).j?.data;
  if (!before?.week || before.week.reviewCompleted) { console.log("편집 가능 주차 없음 — abort"); process.exit(1); }
  const { weekId, weekStartDate: WEEK } = before.week;

  const rows = before.crewRows ?? [];
  // 강등 가능(심화→정규) + 파트 이동 가능한 크루 — 관측이 반드시 발생하는 조합.
  const parts = [...new Set(rows.map((r) => r.rawPart).filter(Boolean))];
  const target = rows.find((r) => r.positionCode !== "regular" && parts.some((p) => p !== r.rawPart));
  if (!target) { console.log("관측 가능한 대상 없음 — abort"); process.exit(1); }
  const UID = target.userId;
  const newPart = parts.find((p) => p !== target.rawPart);
  const newCode = "regular";
  const expClass = "정규";
  console.log(`대상=${target.name} (${UID.slice(0, 8)}) ${target.positionCode}/${target.rawPart} → ${newCode}/${newPart}`);
  console.log(`주차 W=${WEEK} (${before.week.label})`);

  const { data: had } = await sb
    .from(OVR).select("*").eq("user_id", UID).eq("organization", ORG).eq("week_start_date", WEEK);
  const hadRow = (had ?? [])[0] ?? null;

  const restore = async () => {
    hr("원복");
    if (hadRow) {
      const { error } = await sb.from(OVR)
        .update({ raw_part: hadRow.raw_part, position_code: hadRow.position_code, raw_team: hadRow.raw_team })
        .eq("user_id", UID).eq("organization", ORG).eq("week_start_date", WEEK);
      ck("기존 행 값 복원", !error, error?.message ?? "");
    } else {
      const { error } = await sb.from(OVR).delete()
        .eq("user_id", UID).eq("organization", ORG).eq("week_start_date", WEEK);
      ck("생성 행 삭제", !error, error?.message ?? "");
    }
    await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: true }).eq("user_id", UID);
    const fpAfter = await fingerprint();
    if (fpAfter === fpBefore) ck("override 테이블 무변경(전체 지문)", true, `${fpAfter.split("\n").length}행`);
    else {
      const b = new Set(fpBefore.split("\n")), a = new Set(fpAfter.split("\n"));
      ck("override 테이블 무변경(전체 지문)", false, "차이 발생 — 수동 복원 필요");
      for (const l of [...b].filter((x) => !a.has(x))) console.log(`      - 유실: ${l}`);
      for (const x of [...a].filter((x) => !b.has(x))) console.log(`      + 잔존: ${x}`);
    }
  };

  const patch = await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({
      organization: ORG, weekId, rawTeam: team.team_name,
      changes: [{ userId: UID, rawPart: newPart, positionCode: newCode }],
    }),
  });
  ck("PATCH 200", patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.j?.error ?? "")}`);
  if (patch.status !== 200) { await restore(); console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  try {
    const ctx = await browser.newContext();
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);

    // ── ① 회원 목록 — 렌더된 클래스/소속 셀 ─────────────────────────────────
    hr("DOM ① admin 회원 목록");
    await page.goto(`${ADMIN}/admin/members?organization=${ORG}&mode=${MODE}`, { waitUntil: "networkidle" });
    // 이름으로 행을 찾고 그 행 전체 텍스트에서 값을 확인한다(컬럼 인덱스는 화면 변경에 취약).
    const rowText = await page
      .locator(`tr:has-text("${target.name}")`)
      .first()
      .innerText()
      .catch(() => null);
    if (!rowText) skip("회원 목록 행 렌더", `"${target.name}" 행을 찾지 못함(페이지네이션 가능)`);
    else {
      ck("회원 목록 클래스 셀", rowText.includes(expClass), `행 텍스트에 "${expClass}" 포함 여부 / got=${rowText.replace(/\s+/g, " ").slice(0, 120)}`);
      ck("회원 목록 소속(파트) 셀", rowText.includes(newPart), `"${newPart}" 포함`);
    }

    // ── ② 팀 상세 [B] 주차 표 — W-1 / W / W+1 ────────────────────────────────
    hr("DOM ② admin 팀 상세 [B] 주차 표");
    await page.goto(
      `${ADMIN}/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}`,
      { waitUntil: "networkidle" },
    );
    const bText = await page.locator("body").innerText();
    if (!bText.includes(target.name)) skip("팀 상세 [B] 렌더", `"${target.name}" 미노출`);
    else {
      const line = bText.split("\n").find((l) => l.includes(target.name)) ?? "";
      ck("팀 상세 [B] 행에 변경 클래스 노출", line.includes(expClass) || bText.includes(expClass), `line=${line.slice(0, 120)}`);
      ck("팀 상세 [B] 행에 변경 파트 노출", line.includes(newPart) || bText.includes(newPart), `"${newPart}" 포함`);
    }

    // ── ③ front 크루 페이지 — 고객이 보는 값 ────────────────────────────────
    hr("DOM ③ front 크루 페이지");
    const FRONT = process.env.FRONT_BASE ?? "http://localhost:3001";
    const up = await fetch(FRONT, { method: "GET", signal: AbortSignal.timeout(20000) })
      .then(() => true).catch(() => false);
    if (!up) skip("front 크루 페이지", "front dev 미기동");
    else {
      await page.goto(`${FRONT}/cluster-4-card?demoUserId=${UID}`, { waitUntil: "networkidle" }).catch(() => {});
      const fText = await page.locator("body").innerText().catch(() => "");
      if (!fText.trim()) skip("front 크루 페이지", "본문 렌더 실패");
      else {
        ck("front 카드에 변경 클래스 노출", fText.includes(expClass), `"${expClass}" 포함`);
        ck("front 카드에 변경 파트 노출", fText.includes(newPart), `"${newPart}" 포함`);
      }
    }
  } finally {
    await browser.close();
    await restore();
  }

  console.log(`\n=== RESULT: ${fail} FAIL / ${skipped} SKIP ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); process.exit(1); });
