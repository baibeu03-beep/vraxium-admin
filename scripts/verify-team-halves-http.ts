/**
 * 반기별 팀 등록(/admin/team-parts/info) 검증 — 크루 호출·팀 등록·10개 제한·게이트·direct==HTTP·snapshot.
 *
 * 검증(요구사항 대응):
 *   1) direct function 결과 / 2) HTTP API / 3) direct==HTTP
 *   4) 현재 반기 등록 가능 / 5) 과거 반기 등록 403
 *   6) 크루코드 [호출] API / 7) 존재하지 않는 크루코드 → 등록 불가(404)
 *   8) 팀 명 12자 제한 / 9) 팀 개요 200자 제한
 *   10) 한 클럽 10개 초과 등록 불가
 *   11) 등록 후 섹션.1 목록/팀 수 갱신 / 12·13) snapshot 무영향·재계산 불필요
 *
 * 사전조건: 마이그레이션(team_halves + register 컬럼) 적용 + admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-halves-http.ts
 * 잔여 테스트 행은 스크립트 말미에서 정리(net-zero).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  lookupCrewByCode,
  registerTeamHalf,
  listHalfTeams,
  loadTeamPartsInfo,
  resolveCurrentHalfKey,
  ensureGeneralPart,
  TeamHalfWriteError,
} from "@/lib/adminTeamHalvesData";

let GENERAL_PART_ID: string | null = null;

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const TEST_PREFIX = "검증T-";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const sb = createClient(
  ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
  ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

async function makeAdminCookieHeader(): Promise<string> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function snapshotFingerprint() {
  const { count, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true });
  if (error) throw new Error(`snapshot count 실패: ${error.message}`);
  const { data: latest, error: lErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (lErr) throw new Error(`snapshot latest 실패: ${lErr.message}`);
  return { count: count ?? 0, latest: latest?.[0]?.updated_at ?? null };
}

async function cleanupTestRows() {
  await sb
    .from("cluster4_team_halves")
    .delete()
    .like("team_name", `${TEST_PREFIX}%`);
}

async function main() {
  const cookie = await makeAdminCookieHeader();
  const httpGet = async (org: string, half?: string) => {
    const params = new URLSearchParams({ organization: org });
    if (half) params.set("half", half);
    const r = await fetch(`${adminBase}/api/admin/team-parts/info?${params}`, {
      headers: { cookie },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`GET ${org}/${half}: ${r.status} ${j?.error}`);
    return j.data as any;
  };
  const httpLookup = async (code: string) => {
    const r = await fetch(
      `${adminBase}/api/admin/team-parts/crew-lookup?code=${encodeURIComponent(code)}`,
      { headers: { cookie }, cache: "no-store" },
    );
    return { status: r.status, json: await r.json() };
  };
  const httpRegister = async (body: unknown) => {
    const r = await fetch(`${adminBase}/api/admin/team-parts/info`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  console.log("=== 0) 사전 정리 + snapshot 지문(before) ===");
  await cleanupTestRows();
  const snapBefore = await snapshotFingerprint();
  console.log(`  snapshot count=${snapBefore.count}, latest=${snapBefore.latest}`);
  const currentHalf = await resolveCurrentHalfKey();
  check("현재 반기 = 2026-H1", currentHalf === "2026-H1", String(currentHalf));

  // 실제 encre 크루코드 1건 확보.
  const { data: crewRow, error: crewErr } = await sb
    .from("user_profiles")
    .select("user_id,crew_code,display_name")
    .eq("organization_slug", "encre")
    .not("crew_code", "is", null)
    .limit(1)
    .maybeSingle();
  if (crewErr) throw new Error(crewErr.message);
  if (!crewRow?.crew_code) throw new Error("encre crew_code 보유 크루를 찾지 못함");
  const LEADER_CODE = crewRow.crew_code as string;
  console.log(`  테스트 팀장 크루코드=${LEADER_CODE} (${crewRow.display_name})`);

  console.log("\n=== 6) 크루코드 [호출] direct == HTTP ===");
  const directCrew = await lookupCrewByCode(LEADER_CODE);
  const httpCrew = await httpLookup(LEADER_CODE);
  check("HTTP 호출 200 + success", httpCrew.status === 200 && httpCrew.json?.success === true);
  check("direct 호출 결과 존재", directCrew != null);
  if (directCrew && httpCrew.json?.data) {
    const d = directCrew, h = httpCrew.json.data;
    const fields = ["userId","crewCode","name","gender","birth6","residence","school","major","classLabel","teamName","partName","successWeeks","gradeLabel"] as const;
    const same = fields.every((f) => JSON.stringify((d as any)[f]) === JSON.stringify(h[f]));
    check("11개 필드 direct==HTTP", same, fields.map((f)=>`${f}=${(h as any)[f]}`).join(" · "));
  }

  console.log("\n=== 7) 존재하지 않는 크루코드 → 404 / direct null ===");
  const NOPE = "ZZZ-NOPE-9999";
  check("direct null", (await lookupCrewByCode(NOPE)) === null);
  const nope = await httpLookup(NOPE);
  check("HTTP 404", nope.status === 404, `status=${nope.status}`);

  console.log("\n=== 3·5) 과거 반기 등록 → 403 ===");
  const pastReg = await httpRegister({
    organization: "oranke", halfKey: "2025-H1",
    teamName: `${TEST_PREFIX}과거`, description: "과거 반기 테스트", leaderCrewCode: LEADER_CODE,
  });
  check("과거 반기 등록 403", pastReg.status === 403, `status=${pastReg.status} ${pastReg.json?.error ?? ""}`);

  console.log("\n=== 2) 다음 반기(2026-H2) 등록/편집 가능 ===");
  const nextHalf = "2026-H2";
  // 다음 반기가 옵션에 노출되고 editable=true 인지(direct==HTTP).
  const directNext = await loadTeamPartsInfo("encre", nextHalf);
  const httpNext = await httpGet("encre", nextHalf);
  const dOpt = directNext.halves.find((h: any) => h.halfKey === nextHalf);
  const hOpt = httpNext.halves.find((h: any) => h.halfKey === nextHalf);
  check("다음 반기 옵션 노출", Boolean(dOpt) && Boolean(hOpt));
  check("다음 반기 editable=true (direct==HTTP)", dOpt?.editable === true && hOpt?.editable === true, `direct=${dOpt?.editable} http=${hOpt?.editable}`);
  check("다음 반기 isCurrent=false", hOpt?.isCurrent === false, String(hOpt?.isCurrent));
  // 다음 반기 POST → 200.
  const nextReg = await httpRegister({
    organization: "encre", halfKey: nextHalf,
    teamName: `${TEST_PREFIX}다음`, description: "다음 반기 미리 등록", leaderCrewCode: LEADER_CODE,
  });
  check("다음 반기 등록 200", nextReg.status === 200 && nextReg.json?.success === true, `status=${nextReg.status} ${nextReg.json?.error ?? ""}`);
  const nextAfter = await httpGet("encre", nextHalf);
  check("다음 반기 신규 팀 노출", nextAfter.teams.some((t: any) => t.teamName === `${TEST_PREFIX}다음`), nextAfter.teams.map((t:any)=>t.teamName).join("·"));

  console.log("\n=== 8) 팀 명 12자 초과 → 400 ===");
  const longName = await httpRegister({
    organization: "encre", halfKey: "2026-H1",
    teamName: `${TEST_PREFIX}1234567890`, description: "ok", leaderCrewCode: LEADER_CODE,
  });
  check("팀 명 13자 등록 400", longName.status === 400 && /12자/.test(longName.json?.error ?? ""), longName.json?.error ?? "");

  console.log("\n=== 9) 팀 개요 200자 초과 → 400 ===");
  const longDesc = await httpRegister({
    organization: "encre", halfKey: "2026-H1",
    teamName: `${TEST_PREFIX}개요`, description: "가".repeat(201), leaderCrewCode: LEADER_CODE,
  });
  check("팀 개요 201자 등록 400", longDesc.status === 400 && /200자/.test(longDesc.json?.error ?? ""), longDesc.json?.error ?? "");

  console.log("\n=== 7b) 잘못된 팀장 크루코드 → 400(등록 불가) ===");
  const badLeader = await httpRegister({
    organization: "encre", halfKey: "2026-H1",
    teamName: `${TEST_PREFIX}리더`, description: "ok", leaderCrewCode: NOPE,
  });
  check("미존재 팀장 등록 400", badLeader.status === 400 && /크루/.test(badLeader.json?.error ?? ""), badLeader.json?.error ?? "");

  console.log("\n=== 4·11) 현재 반기 등록 성공 + 섹션.1 갱신 ===");
  const before = await httpGet("encre", "2026-H1");
  const beforeCount = before.teams.length;
  const REG_NAME = `${TEST_PREFIX}팀A`;
  const reg = await httpRegister({
    organization: "encre", halfKey: "2026-H1",
    teamName: REG_NAME, description: "검증용 팀 개요", leaderCrewCode: LEADER_CODE,
  });
  check("등록 200 + success", reg.status === 200 && reg.json?.success === true, JSON.stringify(reg.json?.error ?? ""));
  const after = await httpGet("encre", "2026-H1");
  check("팀 수 +1", after.teams.length === beforeCount + 1, `${beforeCount}→${after.teams.length}`);
  const newTeam = after.teams.find((t: any) => t.teamName === REG_NAME);
  check("신규 팀 노출", Boolean(newTeam), JSON.stringify(newTeam ?? null));
  check("팀장 이름 노출(leaderName)", Boolean(newTeam?.leaderName), `leaderName=${newTeam?.leaderName}`);
  check("팀장 crew_code 기록", newTeam?.leaderCrewCode === LEADER_CODE, `${newTeam?.leaderCrewCode}`);

  console.log("\n=== 6·7·8) 일반 파트 자동 생성 + 파트 수/목록 ===");
  check("팀 box 팀장 기본정보(birth6/gender)", Boolean(newTeam?.leaderBirth6) && Boolean(newTeam?.leaderGender), `birth6=${newTeam?.leaderBirth6} gender=${newTeam?.leaderGender} school=${newTeam?.leaderSchool}`);
  check("파트 수 = 1 (생성 직후)", newTeam?.partCount === 1, `partCount=${newTeam?.partCount}`);
  check('파트 목록 = ["일반"]', JSON.stringify(newTeam?.partNames) === JSON.stringify(["일반"]), JSON.stringify(newTeam?.partNames));
  // direct DB: cluster4_team_parts 일반 행 존재.
  const { data: thRow } = await sb
    .from("cluster4_team_halves")
    .select("id,leader_user_id")
    .eq("organization_slug", "encre").eq("half_key", "2026-H1").eq("team_name", REG_NAME).maybeSingle();
  const { data: partRows } = await sb
    .from("cluster4_team_parts")
    .select("id,part_name,is_default,leader_user_id")
    .eq("team_half_id", (thRow as any)?.id);
  const general = (partRows ?? []).find((p: any) => p.part_name === "일반");
  check("일반 파트 DB 자동 생성", Boolean(general), JSON.stringify(general ?? null));
  GENERAL_PART_ID = (general as any)?.id ?? null;
  check("일반 파트 is_default=true", (general as any)?.is_default === true);
  check("일반 파트 기본 파트장=팀장", (general as any)?.leader_user_id === crewRow.user_id, `${(general as any)?.leader_user_id}`);
  // idempotency: ensureGeneralPart 재호출해도 1행 유지.
  await ensureGeneralPart((thRow as any).id, crewRow.user_id);
  await ensureGeneralPart((thRow as any).id, crewRow.user_id);
  const { count: genCount } = await sb
    .from("cluster4_team_parts")
    .select("id", { count: "exact", head: true })
    .eq("team_half_id", (thRow as any).id).eq("part_name", "일반");
  check("일반 파트 중복 생성 안 됨(idempotent)", genCount === 1, `count=${genCount}`);

  console.log("\n=== 3) 등록 결과 direct == HTTP ===");
  const directList = await listHalfTeams("encre", "2026-H1");
  const directTeams = directList.map((t) => t.teamName);
  const httpTeams = after.teams.map((t: any) => t.teamName);
  check("팀 목록 direct==HTTP", JSON.stringify(directTeams) === JSON.stringify(httpTeams), `d=${directTeams.length} h=${httpTeams.length}`);
  // 신규 팀의 box 필드(파트·팀장정보) direct==HTTP.
  const dNew = directList.find((t) => t.teamName === REG_NAME);
  const fields = ["partCount","partNames","leaderName","leaderBirth6","leaderGender","leaderSchool","leaderMajor","leaderResidence","teamHalfId"] as const;
  const boxSame = fields.every((f) => JSON.stringify((dNew as any)?.[f]) === JSON.stringify((newTeam as any)?.[f]));
  check("팀 box 필드 direct==HTTP", boxSame, fields.map((f)=>`${f}=${JSON.stringify((newTeam as any)?.[f])}`).join(" · "));
  // description 저장 확인(direct DB).
  const { data: descRow } = await sb
    .from("cluster4_team_halves")
    .select("description,leader_user_id")
    .eq("organization_slug", "encre").eq("half_key", "2026-H1").eq("team_name", REG_NAME).maybeSingle();
  check("팀 개요 DB 저장", descRow?.description === "검증용 팀 개요", String(descRow?.description));
  check("팀장 user_id DB 저장", descRow?.leader_user_id === crewRow.user_id, String(descRow?.leader_user_id));

  console.log("\n=== 10) 한 클럽 10개 초과 등록 불가 ===");
  // 현재 encre 2026-H1 활성 팀 수 채워서 10개로 만든 뒤 11번째 차단.
  let cur = (await httpGet("encre", "2026-H1")).teams.length;
  let i = 0;
  while (cur < 10) {
    i += 1;
    const r = await httpRegister({
      organization: "encre", halfKey: "2026-H1",
      teamName: `${TEST_PREFIX}fill${i}`, description: "fill", leaderCrewCode: LEADER_CODE,
    });
    if (r.status !== 200) { check(`fill 등록(${i}) 200`, false, `${r.status} ${r.json?.error}`); break; }
    cur += 1;
  }
  check("10개 채움 확인", (await httpGet("encre", "2026-H1")).teams.length === 10, String(cur));
  const overflow = await httpRegister({
    organization: "encre", halfKey: "2026-H1",
    teamName: `${TEST_PREFIX}초과`, description: "초과", leaderCrewCode: LEADER_CODE,
  });
  check("11번째 등록 400", overflow.status === 400, `status=${overflow.status}`);
  check('초과 메시지="한 클럽에는 최대 10개 팀까지만 등록할 수 있습니다."',
    overflow.json?.error === "한 클럽에는 최대 10개 팀까지만 등록할 수 있습니다.", overflow.json?.error ?? "");
  // 백엔드 강제 검증 확인: direct registerTeamHalf 도 동일 차단.
  let directBlocked = false;
  try {
    await registerTeamHalf({ organization: "encre", halfKey: "2026-H1", teamName: `${TEST_PREFIX}직접초과`, description: "x", leaderCrewCode: LEADER_CODE });
  } catch (e) { directBlocked = e instanceof TeamHalfWriteError && e.status === 400; }
  check("direct 도 10개 제한 강제(백엔드 검증)", directBlocked);

  console.log("\n=== 정리(net-zero) + snapshot 지문(after) ===");
  await cleanupTestRows();
  const restored = (await httpGet("encre", "2026-H1")).teams.length;
  check("정리 후 원래 팀 수(5)로 복귀", restored === beforeCount, `${restored} (기준 ${beforeCount})`);
  const snapAfter = await snapshotFingerprint();
  check("snapshot 행수 불변", snapAfter.count === snapBefore.count, `${snapBefore.count}→${snapAfter.count}`);
  check("snapshot 최신 updated_at 불변", snapAfter.latest === snapBefore.latest, `${snapBefore.latest}→${snapAfter.latest}`);

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  console.log(`(등록 테스트 반기=2026-H1, 클럽=encre, 팀=${TEST_PREFIX}팀A, 팀장코드=${LEADER_CODE}, 일반파트id=${GENERAL_PART_ID})`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanupTestRows(); } catch {}
  process.exit(1);
});
