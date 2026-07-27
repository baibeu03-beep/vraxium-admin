/**
 * 주차 파트/클래스 변경의 **비소급(non-retroactive)** 검증 — 실제 HTTP.
 *
 * 요구사항(2026-07-27):
 *   /admin/team-parts/info/* 에서 파트·클래스를 바꾸면
 *     · 변경 주차 **이전** 크루 카드 = 당시 값 그대로(불변)
 *     · 변경 주차 **이후** 크루 카드 = 변경된 값
 *   현재 멤버십/현재 소속값을 모든 주차 카드에 공통 적용하면 안 된다.
 *
 * 회귀 원인(v49 에서 수정): 카드 소속 fallback 이 crew DTO 의 teamName/partName 이었고, 그 값은
 *   getAdminCrewDtoByLegacyUserId 가 resolveCurrentPositionBatch(= **현재 주차** override ?? UPH ??
 *   멤버십)로 이미 덮어쓴 값이었다 → 저장한 override 가 "현재 위치"로 승격돼 override 가 없는
 *   과거 주차 카드 전부에 소급됐다.
 *
 * 검증(전부 실제 HTTP, 실제 저장/원복):
 *   ① 저장 API 가 **변경 시작 주차**를 정확히 기록  PATCH /api/admin/team-parts/info/team-detail/week-position
 *   ② 크루 카드(admin)                            GET  :3000 /api/cluster4/weekly-cards?userId=
 *   ③ 크루 앱(front, 일반/데모/테스트모드 경로)      GET  :3001 /api/cluster4/weekly-cards?…
 *   ④ snapshot 재생성 전후 동일값(is_stale → 재조회)
 *
 * 사전조건: admin dev :3000, front dev :3001.
 * Usage: npm run verify:week-position-nonretro
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
const ADMIN = process.env.ADMIN_BASE ?? "http://127.0.0.1:3000";
const FRONT = process.env.FRONT_BASE ?? "http://127.0.0.1:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const KEY = get("INTERNAL_API_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);
const OVR = "cluster4_team_week_position_overrides";
const SNAP = "cluster4_weekly_card_snapshots";
const ORG = "encre";
const MODE = "test";

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = (t) => console.log(`\n──────── ${t} ────────`);

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// 카드 조회 — startDate → {team,part,code,role}. snapshot 경로(느림) 대비 넉넉한 타임아웃.
async function cards(url) {
  const r = await fetch(url, { headers: { "x-internal-api-key": KEY ?? "" }, cache: "no-store", signal: AbortSignal.timeout(180_000) });
  const j = await r.json().catch(() => null);
  const map = new Map();
  for (const c of j?.data ?? []) {
    map.set(c.startDate, { team: c.teamName ?? null, part: c.partName ?? null, code: c.crewClassPositionCode ?? null, role: c.roleLabel ?? null });
  }
  return { status: r.status, map, count: j?.data?.length ?? 0 };
}
const show = (v) => (v ? `${v.team}/${v.part}/${v.code}` : "(카드없음)");
const eq = (a, b) => a && b && a.team === b.team && a.part === b.part && a.code === b.code && a.role === b.role;

// snapshot 을 실제로 재생성한 뒤 조회한다(현행 코드 기준 값).
//   ⚠ is_stale=true 만 찍으면 부족하다 — dto_version bump 직후에는 readWeeklyCardsSnapshot 이
//     version_mismatch 를 먼저 반환해 **비블로킹 백그라운드** 경로로 빠지고, 그 응답은 구버전
//     카드다. 서버 재계산 엔드포인트로 동기 재생성한 뒤 조회한다.
async function freshCards(userId, url) {
  await sb.from(SNAP).update({ is_stale: true }).eq("user_id", userId);
  const r = await fetch(`${ADMIN}/api/admin/cluster4/recompute-user-snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-api-key": KEY ?? "" },
    body: JSON.stringify({ userIds: [userId] }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!r.ok) console.log(`  ⚠ snapshot 재계산 실패(status=${r.status}) — 조회값이 구버전일 수 있음`);
  return cards(url);
}

async function main() {
  const cookie = await cookieHeader();
  const call = (path, init) =>
    fetch(`${ADMIN}${path}`, {
      ...init,
      headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

  // ── 대상 팀/주차/크루 선정 ────────────────────────────────────────────────
  const { data: th } = await sb.from("cluster4_team_halves")
    .select("id,team_name,half_key").eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true)
    .order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("QA 팀 없음 — abort"); process.exit(1); }
  const TEAM = team.team_name;
  const S = (weekId) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}${weekId ? `&weekId=${weekId}` : ""}`;

  const cur = (await call(S())).j?.data;
  if (!cur?.week) { console.log("주차 없음 — abort"); process.exit(1); }
  const selectable = (cur.selectableWeeks ?? []).slice().sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));

  // 변경 주차 = 앞뒤로 주차가 남는 지점(이전 불변 + 이후 이월을 동시에 관측). 편집 가능해야 한다.
  let pick = null;
  for (let i = selectable.length - 2; i >= 1; i--) {
    const w = selectable[i];
    const probe = (await call(S(w.weekId))).j?.data;
    if (!probe?.week || probe.week.weekId !== w.weekId || probe.week.reviewCompleted) continue;
    pick = { week: w, summary: probe, prev: selectable[i - 1], nexts: selectable.slice(i + 1) };
    break;
  }
  if (!pick) { console.log("편집 가능한 중간 주차 없음 — abort"); process.exit(1); }
  const { week: CHANGE, summary } = pick;
  console.log(`팀=${TEAM} | 변경주차=${CHANGE.label}(${CHANGE.weekStartDate}) | 이전=${pick.prev.weekStartDate} | 이후=${pick.nexts.map((w) => w.weekStartDate).join(",") || "(없음)"}`);

  // 대상 크루 = override 이력이 전혀 없는 크루(이월 관측이 다른 override 에 가려지지 않게).
  const rows = summary.crewRows ?? [];
  const { data: allOvr } = await sb.from(OVR).select("user_id").eq("organization", ORG);
  const hasOvr = new Set((allOvr ?? []).map((o) => o.user_id));
  //   클래스도 함께 바꾸려면 "심화 → 정규"(항상 허용) 방향이 안전하다 — 정규 → 심화는 팀 정원 규칙
  //   (심화 ≤ 정규)에 걸릴 수 있다. 심화 크루가 없으면 정규 → 심화를 시도하고, 422 면 파트만 바꾼다.
  const freeRows = rows.filter((r) => !hasOvr.has(r.userId));
  const target = freeRows.find((r) => r.positionCode !== "regular") ?? freeRows[0] ?? rows[0];
  if (!target) { console.log("대상 크루 없음 — abort"); process.exit(1); }

  const operated = new Set((summary.operatedParts ?? []).map((p) => p.partName));
  const { data: catalog } = await sb.from("cluster4_team_parts")
    .select("part_name,display_order").eq("team_half_id", team.id).order("display_order");
  const newPart = (catalog ?? []).map((c) => c.part_name).find((p) => p && p !== target.rawPart && !operated.has(p));
  if (!newPart) { console.log("이동할 미운용 파트 없음 — abort"); process.exit(1); }
  let newCode = target.positionCode === "regular" ? "advanced_agent" : "regular";
  console.log(`대상 크루=${target.userId} | ${target.rawPart}/${target.positionCode} → ${newPart}/${newCode}`);

  const FRONT_PATHS = [
    ["front 일반(userId)", `${FRONT}/api/cluster4/weekly-cards?userId=${target.userId}`],
    ["front demoUserId", `${FRONT}/api/cluster4/weekly-cards?demoUserId=${target.userId}`],
    ["front mode=test", `${FRONT}/api/cluster4/weekly-cards?userId=${target.userId}&mode=test`],
    ["front actAsTestUserId", `${FRONT}/api/cluster4/weekly-cards?userId=${target.userId}&mode=test&actAsTestUserId=${target.userId}`],
  ];
  const ADMIN_CARDS = `${ADMIN}/api/cluster4/weekly-cards?userId=${target.userId}`;

  // ── BEFORE ───────────────────────────────────────────────────────────────
  hr("BEFORE — 저장 전 주차별 카드(현행 코드로 재계산)");
  const before = await freshCards(target.userId, ADMIN_CARDS);
  ck("admin 카드 조회 200", before.status === 200, `카드 ${before.count}장`);
  const weeksAsc = [...before.map.keys()].sort();
  const prevWeeks = weeksAsc.filter((w) => w < CHANGE.weekStartDate);
  const postWeeks = weeksAsc.filter((w) => w >= CHANGE.weekStartDate);
  for (const w of weeksAsc.slice(-8)) console.log(`    ${w} ${show(before.map.get(w))}`);
  ck("변경 주차 이전 카드 존재(불변 검증 대상)", prevWeeks.length > 0, `${prevWeeks.length}주차`);
  ck("변경 주차 이후 카드 존재(반영 검증 대상)", postWeeks.length > 0, `${postWeeks.length}주차`);

  const ovrBefore = (await sb.from(OVR).select("raw_part,position_code")
    .eq("user_id", target.userId).eq("week_start_date", CHANGE.weekStartDate).eq("organization", ORG).eq("raw_team", TEAM).maybeSingle()).data ?? null;

  // ── ① 저장 API — 변경 시작 주차 기록 ──────────────────────────────────────
  hr("① 저장 API — 변경 시작 주차 기록");
  const save = (part, code) =>
    call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
      method: "PATCH",
      body: JSON.stringify({ organization: ORG, weekId: CHANGE.weekId, rawTeam: TEAM, changes: [{ userId: target.userId, rawPart: part, positionCode: code }] }),
    });
  let patch = await save(newPart, newCode);
  if (patch.status === 422) {
    // 팀 정원 규칙(심화 ≤ 정규 등)에 걸리면 클래스는 그대로 두고 파트만 바꿔 검증을 이어간다.
    console.log(`  ⚠ 클래스 변경 거부(422: ${patch.j?.error}) → 파트만 변경으로 재시도`);
    newCode = target.positionCode;
    patch = await save(newPart, newCode);
  }
  ck("PATCH 200", patch.status === 200, JSON.stringify(patch.j).slice(0, 140));
  if (patch.status !== 200) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  const { data: saved } = await sb.from(OVR)
    .select("week_start_date,week_id,raw_team,raw_part,position_code")
    .eq("user_id", target.userId).eq("organization", ORG).order("week_start_date");
  ck("override 행 1건만 생성(미래 주차 복제 없음)", (saved ?? []).length === 1, JSON.stringify(saved));
  ck("week_start_date = 변경 주차", saved?.[0]?.week_start_date?.slice(0, 10) === CHANGE.weekStartDate, `${saved?.[0]?.week_start_date} vs ${CHANGE.weekStartDate}`);
  ck("week_id = 변경 주차 id", saved?.[0]?.week_id === CHANGE.weekId, `${saved?.[0]?.week_id}`);
  ck("저장 값 = 요청 값", saved?.[0]?.raw_part === newPart && saved?.[0]?.position_code === newCode, `${saved?.[0]?.raw_part}/${saved?.[0]?.position_code}`);

  // ── ② admin 카드 — 이전 불변 / 이후 반영 ──────────────────────────────────
  hr("② 크루 카드(admin) — 변경 주차 경계");
  const after = await cards(ADMIN_CARDS);
  ck("admin 카드 조회 200", after.status === 200, `카드 ${after.count}장`);
  for (const w of weeksAsc.slice(-8)) console.log(`    ${w} ${show(before.map.get(w))}  →  ${show(after.map.get(w))}`);

  let retro = 0;
  for (const w of prevWeeks) if (!eq(before.map.get(w), after.map.get(w))) retro++;
  ck(`변경 주차 이전 ${prevWeeks.length}주차 전부 불변(소급 없음)`, retro === 0, retro > 0 ? `${retro}주차 변경됨` : "");
  let applied = 0;
  for (const w of postWeeks) {
    const v = after.map.get(w);
    if (v?.part === newPart && v?.code === newCode) applied++;
  }
  ck(`변경 주차 + 이후 ${postWeeks.length}주차 전부 새 값(${newPart}/${newCode})`, applied === postWeeks.length,
    postWeeks.map((w) => `${w}=${show(after.map.get(w))}`).join(" "));

  // ── ③ 크루 앱(front) — 열람 경로별 동일 DTO ───────────────────────────────
  hr("③ 크루 앱(front) — 일반/데모/테스트 경로 동일성");
  for (const [label, url] of FRONT_PATHS) {
    const f = await cards(url);
    if (f.status !== 200) { ck(`${label} 200`, false, `status=${f.status}`); continue; }
    let diff = 0;
    for (const w of weeksAsc) if (!eq(after.map.get(w), f.map.get(w))) diff++;
    ck(`${label} — admin DTO 와 주차별 값 동일`, diff === 0 && f.count === after.count,
      `카드 ${f.count}장 / 불일치 ${diff}주차 · 변경주차=${show(f.map.get(CHANGE.weekStartDate))} 이전주차=${show(f.map.get(prevWeeks.at(-1)))}`);
  }

  // ── ④ snapshot 재생성 전후 동일 ───────────────────────────────────────────
  hr("④ snapshot 재생성 전후 동일값");
  const regen = await freshCards(target.userId, ADMIN_CARDS);
  let rdiff = 0;
  for (const w of weeksAsc) if (!eq(after.map.get(w), regen.map.get(w))) rdiff++;
  ck("snapshot 재생성 후에도 주차별 값 동일", rdiff === 0 && regen.count === after.count, `불일치 ${rdiff}주차`);

  // ── 원복 ─────────────────────────────────────────────────────────────────
  hr("원복");
  if (ovrBefore) {
    await call(`/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
      method: "PATCH",
      body: JSON.stringify({ organization: ORG, weekId: CHANGE.weekId, rawTeam: TEAM, changes: [{ userId: target.userId, rawPart: ovrBefore.raw_part, positionCode: ovrBefore.position_code }] }),
    });
  } else {
    await sb.from(OVR).delete().eq("user_id", target.userId).eq("week_start_date", CHANGE.weekStartDate).eq("organization", ORG).eq("raw_team", TEAM);
  }
  const restored = await freshCards(target.userId, ADMIN_CARDS);
  let sdiff = 0;
  for (const w of weeksAsc) if (!eq(before.map.get(w), restored.map.get(w))) sdiff++;
  ck("원복 — 전 주차 BEFORE 값 복귀", sdiff === 0, `불일치 ${sdiff}주차`);

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
