/**
 * 재현 추적 — 사용자가 브라우저에서 실제로 저장한 override 레코드를 기준으로,
 * **각 화면이 실제 호출하는 HTTP 엔드포인트**만 사용해 값이 어느 단계에서 끊기는지 찾는다.
 *
 * 내부 builder 직접 호출 금지. 조회 대상 user_id / week_start_date / organization / raw_team 은
 * override 테이블에서 읽어 고정한다(= 브라우저가 만든 바로 그 레코드).
 *
 * 추적 단계:
 *   A. override 저장값                       (DB 원문)
 *   B. UPH 원본                              (DB 원문 — 비교 기준)
 *   C. 팀 상세 페이지        GET /api/admin/team-parts/info/team-detail/week-summary
 *   D. 다른 어드민 페이지    GET /api/admin/team-parts/info            (파트×주차 존재표)
 *   E. 크루 카드 서빙        GET /api/cluster4/weekly-cards?userId=…   (front 가 proxy 하는 그 라우트)
 *   F. 테스트유저 경로       GET /api/cluster4/weekly-cards?demoUserId=…
 *   G. snapshot 저장 payload (DB 원문)
 *   H. **lazy 재계산 내구성** is_stale=true 로 만든 뒤 E 재호출 →
 *      재계산된 snapshot 이 override 값을 유지하는가, UPH 로 되돌아가는가
 *
 *   Usage: node scripts/trace-week-position-override-realpath.mjs
 *   (읽기 전용 + is_stale 토글만. override/UPH 는 건드리지 않는다.)
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

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.TRACE_BASE ?? "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

const OVR = "cluster4_team_week_position_overrides";
const SNAP = "cluster4_weekly_card_snapshots";

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const hr = (t) => console.log(`\n──────── ${t} ────────`);

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return { cookie: cap.map((i) => `${i.name}=${i.value}`).join("; "), email };
}

const cardAt = (cards, weekStart) =>
  (cards ?? []).find((c) => String(c.startDate ?? "").slice(0, 10) === weekStart) ?? null;

async function main() {
  console.log(`BASE = ${BASE}`);
  const { cookie, email } = await cookieHeader();
  console.log(`admin session = ${email}`);
  const api = (path) =>
    fetch(`${BASE}${path}`, { headers: { cookie, "content-type": "application/json" } })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

  // ── A. 브라우저가 만든 override 레코드 = 재현 기준(고정) ──
  hr("A. override 저장값 (재현 기준 — 브라우저가 만든 레코드)");
  const { data: ovrRows } = await sb
    .from(OVR)
    .select("user_id,organization,week_id,week_start_date,raw_team,raw_part,position_code,updated_by,updated_at")
    .order("updated_at", { ascending: false })
    .limit(10);
  if (!ovrRows?.length) { console.log("override 행 없음 — 재현 불가. abort"); process.exit(1); }
  for (const r of ovrRows)
    console.log(`  ${r.organization} | ${r.raw_team} | ${r.week_start_date} | ${r.raw_part}/${r.position_code} | by=${r.updated_by} @${r.updated_at}`);

  const anchor = ovrRows[0];
  const ORG = anchor.organization;
  const TEAM = anchor.raw_team;
  const WEEK = String(anchor.week_start_date).slice(0, 10);
  const targets = ovrRows.filter((r) => r.organization === ORG && r.raw_team === TEAM && String(r.week_start_date).slice(0, 10) === WEEK);
  console.log(`\n  고정 스코프: organization=${ORG} raw_team=${TEAM} week_start_date=${WEEK} 대상=${targets.length}명`);

  // 팀/주차 해소 — 브라우저 URL 파라미터와 동일하게.
  //   ⚠ 같은 team_name 에 반기별 team_half 행이 여러 개 존재한다(2025-H2/2026-H1/2026-H2).
  //     그 주차를 **실제로 포함하는 반기**를 골라야 한다 — 아무거나 집으면 weekColumns 에
  //     그 주차가 없어(idx=-1) 매트릭스 비교가 무의미해진다.
  const { data: thAll } = await sb
    .from("cluster4_team_halves").select("id,team_name,half_key,is_qa_test")
    .eq("organization_slug", ORG).eq("team_name", TEAM).eq("is_active", true);
  const { data: weekSeason } = await sb.from("weeks").select("season_key").eq("start_date", WEEK).maybeSingle();
  console.log(`  후보 반기: ${(thAll ?? []).map((r) => `${r.half_key}(${r.id.slice(0, 8)})`).join(", ")} / week season_key=${weekSeason?.season_key}`);
  const { data: wk } = await sb.from("weeks").select("id,start_date,week_number,season_key").eq("start_date", WEEK).limit(1);
  const weekId = wk?.[0]?.id;
  const MODE0 = (thAll ?? [])[0]?.is_qa_test ? "test" : "operating";
  // 그 주차를 포함하는 반기 = info API 의 weekColumns 에 WEEK 가 있는 반기(실제 화면 기준으로 판정).
  let teamHalf = null;
  let infoForHalf = null;
  for (const cand of thAll ?? []) {
    const r = await api(`/api/admin/team-parts/info?organization=${ORG}&half=${cand.half_key}&mode=${MODE0}`);
    const cols = r.j?.data?.weekColumns ?? [];
    if (cols.some((c) => c.weekStartDate === WEEK)) { teamHalf = cand; infoForHalf = r; break; }
  }
  if (!teamHalf) { console.log(`  ❌ ${WEEK} 를 포함하는 반기 없음 — abort`); process.exit(1); }
  const MODE = teamHalf.is_qa_test ? "test" : "operating";
  console.log(`  선택 반기: teamHalfId=${teamHalf.id} half=${teamHalf.half_key} is_qa_test=${teamHalf.is_qa_test} → mode=${MODE}`);
  console.log(`  weekId=${weekId}`);

  // ── B. UPH 원본(비교 기준) ──
  hr("B. UPH 원본 (override 와 다른 값이어야 '전파'를 관찰할 수 있음)");
  const ids = targets.map((t) => t.user_id);
  const { data: uph } = await sb
    .from("user_position_histories").select("user_id,raw_team,raw_part,position_code")
    .in("user_id", ids).eq("week_start_date", WEEK).eq("organization", ORG);
  const uphByUser = new Map((uph ?? []).map((r) => [r.user_id, r]));
  const names = new Map();
  for (const t of targets) {
    const { data: p } = await sb.from("user_profiles").select("display_name,role").eq("user_id", t.user_id).maybeSingle();
    names.set(t.user_id, p?.display_name ?? t.user_id);
    const u = uphByUser.get(t.user_id);
    console.log(`  ${p?.display_name ?? t.user_id} (${t.user_id})`);
    console.log(`     override = ${t.raw_part}/${t.position_code}`);
    console.log(`     UPH      = ${u ? `${u.raw_part}/${u.position_code}` : "(행 없음 — 멤버십 폴백)"}`);
  }

  // ── C. 팀 상세 페이지(변경한 그 화면) ──
  hr("C. 팀 상세 페이지 — GET /api/admin/team-parts/info/team-detail/week-summary");
  const cUrl = `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${teamHalf?.id}&mode=${MODE}&weekId=${weekId}`;
  console.log(`  URL: ${cUrl}`);
  const cRes = await api(cUrl);
  ck("HTTP 200", cRes.status === 200, `status=${cRes.status}`);
  const cRows = cRes.j?.data?.crewRows ?? [];
  for (const t of targets) {
    const row = cRows.find((r) => r.userId === t.user_id);
    ck(`[C] ${names.get(t.user_id)} = override 값`,
      row?.rawPart === t.raw_part && row?.positionCode === t.position_code,
      `응답=${row?.rawPart}/${row?.positionCode} 기대=${t.raw_part}/${t.position_code}`);
  }

  // ── D. 다른 어드민 페이지(파트×주차 존재표) ──
  hr("D. 다른 어드민 페이지 — GET /api/admin/team-parts/info (파트×주차 존재표)");
  const dUrl = `/api/admin/team-parts/info?organization=${ORG}&half=${teamHalf?.half_key}&mode=${MODE}`;
  console.log(`  URL: ${dUrl}`);
  const dRes = await api(dUrl);
  ck("HTTP 200", dRes.status === 200, `status=${dRes.status}`);
  const info = dRes.j?.data;
  const wi = (info?.weekColumns ?? []).findIndex((c) => c.weekStartDate === WEEK);
  const tDto = (info?.teams ?? []).find((t) => t.teamName === TEAM);
  const onParts = new Set();
  if (wi >= 0 && tDto?.partWeekMatrix)
    tDto.partWeekMatrix.partNames.forEach((p, y) => { if (tDto.partWeekMatrix.present?.[y]?.[wi]) onParts.add(p); });
  console.log(`  ${WEEK} 컬럼(idx=${wi}) ON 파트: [${[...onParts].join(",")}]`);
  for (const t of targets)
    ck(`[D] override 파트 "${t.raw_part}" 가 존재표에 ON`, onParts.has(t.raw_part), `[${[...onParts].join(",")}]`);

  // ── E. 크루 카드 서빙(front 가 proxy 하는 그 라우트) ──
  hr("E. 크루 카드 서빙 — GET /api/cluster4/weekly-cards?userId=… (front proxy 대상)");
  const eByUser = new Map();
  for (const t of targets) {
    const eUrl = `/api/cluster4/weekly-cards?userId=${t.user_id}`;
    const eRes = await api(eUrl);
    const card = cardAt(eRes.j?.data, WEEK);
    eByUser.set(t.user_id, card);
    console.log(`  URL: ${eUrl} → ${eRes.status}`);
    ck(`[E] ${names.get(t.user_id)} 카드 class = override`,
      card?.crewClassPositionCode === t.position_code,
      `응답=${card?.crewClassPositionCode} 기대=${t.position_code} (roleLabel=${card?.roleLabel})`);
  }

  // ── F. 테스트유저 경로(demoUserId) ──
  hr("F. 테스트유저 경로 — GET /api/cluster4/weekly-cards?demoUserId=…");
  for (const t of targets) {
    const fUrl = `/api/cluster4/weekly-cards?demoUserId=${t.user_id}`;
    const fRes = await api(fUrl);
    const card = cardAt(fRes.j?.data, WEEK);
    console.log(`  URL: ${fUrl} → ${fRes.status}`);
    const same = JSON.stringify(card) === JSON.stringify(eByUser.get(t.user_id));
    ck(`[F] ${names.get(t.user_id)} demoUserId 응답 == userId 응답(동일 DTO)`, same,
      `class=${card?.crewClassPositionCode}`);
  }

  // ── G. snapshot 저장 payload ──
  hr("G. snapshot 저장 payload (DB 원문)");
  const { data: snaps } = await sb.from(SNAP).select("user_id,dto_version,is_stale,computed_at,cards").in("user_id", ids);
  for (const s of snaps ?? []) {
    const t = targets.find((x) => x.user_id === s.user_id);
    const card = cardAt(s.cards, WEEK);
    const savedAfter = new Date(s.computed_at) >= new Date(t.updated_at);
    console.log(`  ${names.get(s.user_id)} dto_version=${s.dto_version} is_stale=${s.is_stale} computed_at=${s.computed_at}`);
    ck(`[G] snapshot computed_at >= override updated_at(${t.updated_at})`, savedAfter,
      savedAfter ? "" : "저장 후 재계산이 일어나지 않았다");
    ck(`[G] snapshot payload class = override`, card?.crewClassPositionCode === t.position_code,
      `payload=${card?.crewClassPositionCode} 기대=${t.position_code}`);
  }

  // ── H. lazy 재계산 내구성 — is_stale 로 재계산 유도 후 값이 UPH 로 되돌아가는가 ──
  hr("H. lazy 재계산 내구성 — is_stale=true → 서빙 라우트 재호출 → payload 재확인");
  for (const t of targets) {
    await sb.from(SNAP).update({ is_stale: true }).eq("user_id", t.user_id);
    const before = (await sb.from(SNAP).select("computed_at").eq("user_id", t.user_id).maybeSingle()).data?.computed_at;
    const res = await api(`/api/cluster4/weekly-cards?userId=${t.user_id}`);
    const servedCard = cardAt(res.j?.data, WEEK);
    const { data: after } = await sb.from(SNAP).select("is_stale,computed_at,cards").eq("user_id", t.user_id).maybeSingle();
    const storedCard = cardAt(after?.cards, WEEK);
    console.log(`  ${names.get(t.user_id)}: computed_at ${before} → ${after?.computed_at} (is_stale=${after?.is_stale})`);
    ck(`[H] 재계산 실행됨`, after?.computed_at !== before, `${after?.computed_at}`);
    ck(`[H] 재계산 응답 class = override(UPH 로 되돌아가지 않음)`,
      servedCard?.crewClassPositionCode === t.position_code,
      `served=${servedCard?.crewClassPositionCode} 기대=${t.position_code}`);
    ck(`[H] 재계산 저장 payload class = override`,
      storedCard?.crewClassPositionCode === t.position_code,
      `stored=${storedCard?.crewClassPositionCode}`);
  }

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
