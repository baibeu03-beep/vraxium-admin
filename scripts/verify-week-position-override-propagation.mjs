/**
 * 완료 조건 검증 — 한 번의 실제 PATCH(관리자 드롭다운 저장) 후, 사용자가 보는 **모든 화면의 실제
 * HTTP 응답**이 같은 소속/클래스를 보여주는지 확인하고, 원복까지 확인한다.
 *
 * 이전 버전의 결함(2026-07-22 실측으로 드러남)을 모두 막는다:
 *   · 회원 목록(/api/admin/members)을 호출하지 않아 "다른 어드민 페이지" 미검증 → 추가
 *   · 크루 앱(front :3001)을 호출하지 않아 사용자가 보는 앱 미검증 → 추가
 *   · 클래스만 단언하고 소속(part)은 단언하지 않음 → 양쪽 모두 단언
 *   · 파트를 "현재 멤버십과 같은 값"으로 바꿔 변화가 관측되지 않음 → 반드시 다른 파트로 이동
 *   · 클래스를 못 바꾸면 조용히 통과 → 클래스가 안 바뀌면 실패 처리
 *
 * 검증 화면(전부 실제 브라우저가 호출하는 URL):
 *   ① 팀 상세 [B]      GET  /api/admin/team-parts/info/team-detail/week-summary
 *   ② 팀 상세 [A]      GET  /api/admin/team-parts/info/team-detail        (현재 크루 수 == [B] 집계)
 *   ③ 파트×주차 존재표 GET  /api/admin/team-parts/info
 *   ④ 회원 목록        GET  /api/admin/members                            (클래스/소속 컬럼)
 *   ⑤ 크루카드(admin)  GET  /api/cluster4/weekly-cards?userId=…           (front 가 proxy 하는 라우트)
 *   ⑥ 크루 앱(front)   GET  http://localhost:3001/api/cluster4/weekly-cards?demoUserId=…
 *
 *   사전조건: admin dev :3000, front dev :3001.
 *   Usage: node scripts/verify-week-position-override-propagation.mjs
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
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const FRONT = process.env.FRONT_BASE ?? "http://localhost:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const OVR = "cluster4_team_week_position_overrides";
const CODE_LABEL = {
  regular: "정규", advanced_agent: "심화(에이전트)", advanced_part_leader: "심화(파트장)",
};

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
  console.log(`admin session = ${email}`);
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const call = (base, path, init) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init?.headers ?? {}) } })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  // front dev 서버 확인 — 없으면 ⑥ 를 검증할 수 없으므로 실패 처리(조용한 스킵 금지).
  const frontUp = await fetch(FRONT, { method: "HEAD" }).then(() => true).catch(() => false);
  ck(`front dev(${FRONT}) 기동`, frontUp, frontUp ? "" : "크루 앱 미기동 — ⑥ 검증 불가");
  if (!frontUp) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  // ── 대상 선정 ──
  const { data: th } = await sb.from("cluster4_team_halves")
    .select("id,team_name,half_key,is_qa_test,organization_slug")
    .eq("organization_slug", "encre").eq("is_active", true).eq("is_qa_test", true).order("display_order").limit(1);
  const team = th?.[0];
  if (!team) { console.log("QA 팀 없음 — abort"); process.exit(1); }
  const ORG = "encre", TEAM = team.team_name, MODE = "test";
  const S = (weekId) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}${weekId ? `&weekId=${weekId}` : ""}`;
  const before = (await call(ADMIN, S())).j?.data;
  if (!before?.week || before.week.reviewCompleted) { console.log("편집 가능한 주차 없음 — abort"); process.exit(1); }
  const { weekId, weekStartDate: WEEK } = before.week;
  console.log(`팀=${TEAM} half=${team.half_key} 주차=${before.week.label}(${WEEK})`);

  const rowsAll = before.crewRows ?? [];
  const reg = rowsAll.filter((r) => r.positionCode === "regular").length;
  const advRow = rowsAll.find((r) => r.positionCode !== "regular");
  // 클래스가 **반드시 바뀌는** 방향을 고른다(심화→정규는 제약 없음).
  const target = advRow ?? rowsAll[0];
  const newClass = advRow ? "regular" : (rowsAll.length - reg + 1 <= reg - 1 ? "advanced_agent" : null);
  ck("클래스가 실제로 바뀌는 대상 확보", newClass != null && newClass !== target.positionCode,
    `${target?.positionCode} → ${newClass}`);
  if (!newClass) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  // 소속도 **반드시 다른 파트**로 이동(현재 값과 같으면 변화가 관측되지 않는다).
  const { data: catalog } = await sb.from("cluster4_team_parts")
    .select("part_name,display_order").eq("team_half_id", team.id).order("display_order");
  const operated = new Set((before.operatedParts ?? []).map((p) => p.partName));
  const lastInPart = rowsAll.filter((r) => r.userId !== target.userId && r.rawPart === target.rawPart).length === 0;
  const budgetOk = operated.size < 6 || lastInPart;
  const newPart =
    (budgetOk ? (catalog ?? []).map((c) => c.part_name).find((p) => p && p !== target.rawPart && !operated.has(p)) : null) ??
    rowsAll.map((r) => r.rawPart).find((p) => p && p !== target.rawPart) ?? null;
  ck("소속이 실제로 바뀌는 파트 확보", newPart != null && newPart !== target.rawPart, `${target.rawPart} → ${newPart}`);
  if (!newPart) { console.log(`\n=== RESULT: ${fail} FAIL ===`); process.exit(1); }

  const { data: prof } = await sb.from("user_profiles").select("display_name").eq("user_id", target.userId).maybeSingle();
  console.log(`대상: ${prof?.display_name} (${target.userId})`);
  const orig = { part: target.rawPart, code: target.positionCode };
  const ovrBefore = (await sb.from(OVR).select("raw_part,position_code")
    .eq("user_id", target.userId).eq("week_start_date", WEEK).eq("organization", ORG).eq("raw_team", TEAM).maybeSingle()).data ?? null;

  // 각 화면을 읽어 (part, classCode/label) 을 뽑는 공용 리더.
  const readAll = async () => {
    const [a, td, info, ml, wc, fc] = await Promise.all([
      call(ADMIN, S(weekId)),
      call(ADMIN, `/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}`),
      call(ADMIN, `/api/admin/team-parts/info?organization=${ORG}&half=${team.half_key}&mode=${MODE}`),
      call(ADMIN, `/api/admin/members?organization=${ORG}&mode=${MODE}&limit=200`),
      call(ADMIN, `/api/cluster4/weekly-cards?userId=${target.userId}`),
      call(FRONT, `/api/cluster4/weekly-cards?demoUserId=${target.userId}`),
    ]);
    const bRows = a.j?.data?.crewRows ?? [];
    const b = bRows.find((r) => r.userId === target.userId);
    const cc = td.j?.data?.currentTeam?.currentCrew ?? td.j?.data?.team?.currentCrew ?? null;
    const dto = info.j?.data;
    const wi = (dto?.weekColumns ?? []).findIndex((c) => c.weekStartDate === WEEK);
    const tDto = (dto?.teams ?? []).find((t) => t.teamName === TEAM);
    const onParts = new Set();
    if (wi >= 0 && tDto?.partWeekMatrix)
      tDto.partWeekMatrix.partNames.forEach((p, y) => { if (tDto.partWeekMatrix.present?.[y]?.[wi]) onParts.add(p); });
    const m = (ml.j?.data?.rows ?? ml.j?.data?.members ?? ml.j?.data ?? []).find?.((r) => r.userId === target.userId);
    const card = (wc.j?.data ?? []).find((c) => String(c.startDate ?? "").slice(0, 10) === WEEK);
    const fcard = (fc.j?.data ?? []).find((c) => String(c.startDate ?? "").slice(0, 10) === WEEK);
    return {
      b, onParts, member: m, card, fcard,
      aCrew: cc,
      bCounts: {
        regular: bRows.filter((r) => r.positionCode === "regular").length,
        advanced: bRows.filter((r) => String(r.positionCode).startsWith("advanced")).length,
      },
    };
  };

  const assertAll = (snap, expPart, expCode, tag) => {
    const expLabel = CODE_LABEL[expCode];
    ck(`${tag} ① 팀 상세 [B]`, snap.b?.rawPart === expPart && snap.b?.positionCode === expCode,
      `${snap.b?.rawPart}/${snap.b?.positionCode}`);
    ck(`${tag} ② 팀 상세 [A] 현재크루 == [B] 집계`,
      snap.aCrew ? snap.aCrew.regularCrewCount === snap.bCounts.regular && snap.aCrew.advancedCrewCount === snap.bCounts.advanced : false,
      `[A]정규${snap.aCrew?.regularCrewCount}/심화${snap.aCrew?.advancedCrewCount} vs [B]정규${snap.bCounts.regular}/심화${snap.bCounts.advanced}`);
    ck(`${tag} ③ 파트×주차 존재표에 ON`, snap.onParts.has(expPart), `[${[...snap.onParts].join(",")}]`);
    ck(`${tag} ④ 회원 목록 클래스/소속`,
      snap.member?.classLabel === expLabel && snap.member?.currentPartName === expPart,
      `${snap.member?.currentPartName}/${snap.member?.classLabel}`);
    ck(`${tag} ⑤ 크루카드(admin serving)`,
      snap.card?.partName === expPart && snap.card?.crewClassPositionCode === expCode,
      `${snap.card?.partName}/${snap.card?.crewClassPositionCode}`);
    ck(`${tag} ⑥ 크루 앱(front :3001)`,
      snap.fcard?.partName === expPart && snap.fcard?.crewClassPositionCode === expCode,
      `${snap.fcard?.partName}/${snap.fcard?.crewClassPositionCode}`);
  };

  const patch = (part, code) => call(ADMIN, `/api/admin/team-parts/info/team-detail/week-position?mode=${MODE}`, {
    method: "PATCH",
    body: JSON.stringify({ organization: ORG, weekId, rawTeam: TEAM, changes: [{ userId: target.userId, rawPart: part, positionCode: code }] }),
  });

  // ── 변경 ──
  hr(`변경 저장: ${orig.part}/${orig.code} → ${newPart}/${newClass}`);
  const p1 = await patch(newPart, newClass);
  ck("PATCH 200", p1.status === 200, JSON.stringify(p1.j).slice(0, 100));
  ck("snapshot invalidate 실행", Boolean(p1.j?.data?.invalidated?.mode && p1.j.data.invalidated.mode !== "none"),
    JSON.stringify(p1.j?.data?.invalidated));

  hr("변경 후 — 6개 화면 실제 HTTP 응답");
  assertAll(await readAll(), newPart, newClass, "[after]");

  // ── 원복 ──
  hr(`원복: ${newPart}/${newClass} → ${orig.part}/${orig.code}`);
  const p2 = await patch(orig.part, orig.code);
  ck("원복 PATCH 200", p2.status === 200, JSON.stringify(p2.j).slice(0, 80));
  if (!ovrBefore) {
    await sb.from(OVR).delete().eq("user_id", target.userId).eq("week_start_date", WEEK)
      .eq("organization", ORG).eq("raw_team", TEAM);
    // override 행 삭제는 무효화 훅을 타지 않으므로 snapshot 을 명시 재계산해 base 값으로 되돌린다.
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/backfill-week-position-override-snapshots.ts", "--apply", `--users=${target.userId}`],
        { cwd: adminRoot, stdio: "ignore", shell: true });
    } catch { console.log("  ⚠ 원복 snapshot 재계산 실패 — 수동 실행 필요"); }
  }
  hr("원복 후 — 6개 화면 재확인");
  const back = await readAll();
  ck("[restore] ① 팀 상세 [B] 원값", back.b?.rawPart === orig.part && back.b?.positionCode === orig.code,
    `${back.b?.rawPart}/${back.b?.positionCode}`);
  ck("[restore] ⑤ 크루카드 원값", back.card?.crewClassPositionCode === orig.code, `${back.card?.crewClassPositionCode}`);
  ck("[restore] ⑥ 크루 앱 원값", back.fcard?.crewClassPositionCode === orig.code, `${back.fcard?.crewClassPositionCode}`);

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
