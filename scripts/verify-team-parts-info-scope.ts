/**
 * /admin/team-parts/info — 크루 org·mode 스코프 + 팀 등록 노출 정합 검증 (실제 HTTP + direct).
 *
 * 검증(요구사항 대응):
 *   크루 호출: 1) 현재 org 성공 2) 타 org 차단 3·4) 실사용자(operating) 차단
 *              5) API 직접 호출도 차단 6) org 파라미터 누락 400
 *   등록 노출: 7·10) GET=스코프 팀만 8·9) 스코프 밖 이름 등록 = 422(조용히 저장 안 됨)
 *              11) 등록 성공 직후 목록/카운트 반영 12) 삭제 시 즉시 반영 13) 팀장 타org 차단
 *              14) 일반==test 동일 함수 15) direct==HTTP
 *
 * QA(QA_HIDE_REAL_USERS=true): 읽기/쓰기 모두 실효 모드=test 로 고정 → 정합.
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-parts-info-scope.ts
 * (사전: admin dev :3000 실행)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadTeamPartsInfo, lookupCrewByCode, resolveCurrentHalfKey } from "@/lib/adminTeamHalvesData";

const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
// 쓰기(등록/삭제)는 현재·다음 반기만 허용 → 현재 편집 가능 반기를 런타임에 해석해서 쓴다.
let HALF = "2026-H2";

function env(n: string) { const v = process.env[n]; if (!v) throw new Error(`Missing env: ${n}`); return v; }
const sb = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

async function adminCookie(): Promise<string> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL"), anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(url, anon);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !link?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: vd, error: ve } = await browser.auth.verifyOtp({ email: adminEmail, token: link.properties.email_otp, type: "magiclink" });
  if (ve || !vd.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(url, anon, { cookies: { getAll: () => [], setAll: (items) => void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) } });
  const { error } = await server.auth.setSession({ access_token: vd.session.access_token, refresh_token: vd.session.refresh_token });
  if (error) throw new Error(error.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

// dev 서버 keep-alive 드롭(ECONNRESET) 대비 — connection:close + 재시도.
async function rfetch(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await fetch(url, { ...init, headers: { ...(init.headers as any), connection: "close" } });
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250 * (i + 1))); }
  }
  throw lastErr;
}

async function main() {
  const cookie = await adminCookie();
  HALF = (await resolveCurrentHalfKey()) ?? HALF;
  console.log(`편집 대상 반기(현재) = ${HALF}`);
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const lookup = async (code: string, org?: string, mode?: string) => {
    const p: Record<string, string> = { code };
    if (org) p.organization = org;
    if (mode) p.mode = mode;
    const r = await rfetch(`${base}/api/admin/team-parts/crew-lookup?${q(p)}`, { headers: { cookie }, cache: "no-store" });
    return { status: r.status, json: await r.json() as any };
  };
  const getInfo = async (org: string, mode?: string) => {
    const p: Record<string, string> = { organization: org, half: HALF };
    if (mode) p.mode = mode;
    const r = await rfetch(`${base}/api/admin/team-parts/info?${q(p)}`, { headers: { cookie }, cache: "no-store" });
    const j = await r.json() as any;
    if (!r.ok || !j.success) throw new Error(`GET ${org}: ${r.status} ${j?.error}`);
    return j.data;
  };
  const register = async (body: unknown, mode?: string) => {
    const suffix = mode ? `?${q({ mode })}` : "";
    const r = await rfetch(`${base}/api/admin/team-parts/info${suffix}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const del = async (body: unknown, mode?: string) => {
    const suffix = mode ? `?${q({ mode })}` : "";
    const r = await rfetch(`${base}/api/admin/team-parts/info${suffix}`, { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };

  // 실제 test 크루 확보(org별 1건, 3개 org 전체).
  const testCrews = await lookupTestCrews();
  const encreCrew = testCrews.encre, orankeCrew = testCrews.oranke;
  // 실사용자(operating) 크루 — QA 에선 스코프 밖.
  const { data: realRow } = await sb.from("user_profiles").select("crew_code").eq("organization_slug", "encre").not("crew_code", "is", null).limit(30);
  const testIds = new Set(await allTestIds());
  const realCrew = await firstRealCrew("encre", testIds);
  console.log(`crews: encreTest=${encreCrew} orankeTest=${orankeCrew} encreReal=${realCrew}`);

  console.log("\n=== 1·5) 현재 org 소속 test 크루 호출 성공(HTTP) ===");
  const ok1 = await lookup(encreCrew, "encre", "test");
  check("encre test 크루 · org=encre → 200", ok1.status === 200 && ok1.json?.success === true, `${ok1.status} org=${ok1.json?.data?.organizationSlug}`);
  check("응답 org == encre", ok1.json?.data?.organizationSlug === "encre", ok1.json?.data?.organizationSlug);

  console.log("\n=== 2·5) 타 org 크루 호출 차단(HTTP + direct) ===");
  const x1 = await lookup(encreCrew, "oranke", "test");
  check("encre 크루 · org=oranke → 404", x1.status === 404, `${x1.status} ${x1.json?.error ?? ""}`);
  const x2 = await lookup(orankeCrew, "encre", "test");
  check("oranke 크루 · org=encre → 404", x2.status === 404, `${x2.status}`);
  const dCross = await lookupCrewByCode(encreCrew, "test", "oranke");
  check("direct lookupCrewByCode(encre,·,oranke) == null", dCross === null);
  const dSame = await lookupCrewByCode(encreCrew, "test", "encre");
  check("direct lookupCrewByCode(encre,·,encre) != null", dSame !== null, `org=${dSame?.organizationSlug}`);

  console.log("\n=== 3·4) 실사용자(operating 모집단) 크루 차단 — QA 고정 test ===");
  if (realCrew) {
    const rr = await lookup(realCrew, "encre", "test");
    check("실사용자 크루 · mode=test → 404", rr.status === 404, `${rr.status}`);
    const rr2 = await lookup(realCrew, "encre"); // mode 미지정(operating URL)
    check("실사용자 크루 · mode 미지정 → 404 (QA 고정)", rr2.status === 404, `${rr2.status}`);
  } else check("실사용자 크루 확보", false, "no real crew");

  console.log("\n=== 6) org 파라미터 누락 → 400 ===");
  const noOrg = await lookup(encreCrew, undefined, "test");
  check("org 없는 호출 → 400", noOrg.status === 400, `${noOrg.status} ${noOrg.json?.error ?? ""}`);

  console.log("\n=== 7·10·14·15) GET = 스코프((T)) 팀만 · direct==HTTP · 카운트 SoT ===");
  const http = await getInfo("encre", "test");
  const direct = await loadTeamPartsInfo("encre", HALF, undefined, "test");
  const httpNames = http.teams.map((t: any) => t.teamName).sort();
  const directNames = direct.teams.map((t) => t.teamName).sort();
  check("GET(encre,test) = 3개 (T)팀", httpNames.length === 3 && httpNames.every((n: string) => n.endsWith("(T)")), httpNames.join("·"));
  check("direct==HTTP 팀 목록", JSON.stringify(httpNames) === JSON.stringify(directNames), `h=${httpNames.length} d=${directNames.length}`);
  check("카운트 SoT == 목록 길이(동일 원천)", http.teams.length === httpNames.length);
  // 일반 모드(mode 미지정)도 QA 고정 test → 동일 목록.
  const httpOperating = await getInfo("encre");
  check("일반 모드 GET == test GET (같은 조회 함수)", JSON.stringify(httpOperating.teams.map((t: any) => t.teamName).sort()) === JSON.stringify(httpNames));

  console.log("\n=== 8·9) (T) 없는 임의 새 이름도 정상 등록(레지스트리 무관) + effective mode 각인 ===");
  const OUT = "검증임의명";
  await sb.from("cluster4_team_halves").delete().eq("organization_slug", "encre").eq("half_key", HALF).eq("team_name", OUT);
  const reg8 = await register({ organization: "encre", halfKey: HALF, teamName: OUT, description: "임의 이름 신규", leaderCrewCode: encreCrew }, "test");
  check("비-(T) 임의명 test 등록 → 200(레지스트리 무관)", reg8.status === 200 && reg8.json?.success === true, `${reg8.status} ${reg8.json?.error ?? ""}`);
  const { data: row8 } = await sb.from("cluster4_team_halves").select("is_qa_test,is_active").eq("organization_slug", "encre").eq("half_key", HALF).eq("team_name", OUT).maybeSingle();
  check("스코프=effective mode 각인(is_qa_test=true)", (row8 as any)?.is_qa_test === true && (row8 as any)?.is_active === true, JSON.stringify(row8));
  await sb.from("cluster4_team_halves").delete().eq("organization_slug", "encre").eq("half_key", HALF).eq("team_name", OUT);
  check("정리 후 잔여 없음", ((await sb.from("cluster4_team_halves").select("id").eq("organization_slug", "encre").eq("half_key", HALF).eq("team_name", OUT)).data ?? []).length === 0);

  console.log("\n=== 13) 팀장 타 org 크루 → 등록 400 (서버 fail-closed) ===");
  // 활성 (T) 팀을 잠시 삭제 후, 오랑캐 팀장으로 재등록 시도(차단 확인) → 이후 정상 복원.
  const target = "팬덤실험(T)";
  const { data: capRow } = await sb.from("cluster4_team_halves")
    .select("id,description,is_active,display_order,leader_user_id,leader_crew_code")
    .eq("organization_slug", "encre").eq("half_key", HALF).eq("team_name", target).maybeSingle();
  const cap = capRow as any;
  if (!cap) { check("대상 (T)팀 확보", false, target); }
  else {
    const beforeCount = (await getInfo("encre", "test")).teams.length;
    const delRes = await del({ organization: "encre", halfKey: HALF, teamHalfId: cap.id }, "test");
    check("11·12) (T)팀 삭제 200", delRes.status === 200, `${delRes.status}`);
    const afterDel = await getInfo("encre", "test");
    check("12) 삭제 즉시 목록 반영(-1)", afterDel.teams.length === beforeCount - 1 && !afterDel.teams.some((t: any) => t.teamName === target), `${beforeCount}→${afterDel.teams.length}`);

    // 13) 타 org(oranke) 팀장으로 재등록 → 400.
    const badLeader = await register({ organization: "encre", halfKey: HALF, teamName: target, description: cap.description ?? "x", leaderCrewCode: orankeCrew }, "test");
    check("13) 타org 팀장 재등록 → 400", badLeader.status === 400, `${badLeader.status} ${badLeader.json?.error ?? ""}`);
    const stillGone = await getInfo("encre", "test");
    check("13) 실패 후에도 저장 안 됨", !stillGone.teams.some((t: any) => t.teamName === target));

    // 11) 올바른 org 팀장으로 재등록 → 200 + 즉시 노출.
    const leaderCode = cap.leader_crew_code && (await isEncreTestCrew(cap.leader_crew_code, testIds)) ? cap.leader_crew_code : encreCrew;
    const reReg = await register({ organization: "encre", halfKey: HALF, teamName: target, description: cap.description ?? "복원", leaderCrewCode: leaderCode }, "test");
    check("11) 정상 재등록 200", reReg.status === 200 && reReg.json?.success === true, `${reReg.status} ${reReg.json?.error ?? ""}`);
    const afterReg = await getInfo("encre", "test");
    const newTeam = afterReg.teams.find((t: any) => t.teamName === target);
    check("11) 재등록 즉시 목록 노출(+1)", afterReg.teams.length === beforeCount && Boolean(newTeam), `count=${afterReg.teams.length} present=${Boolean(newTeam)}`);
    check("11) 팀장 이름 노출", Boolean(newTeam?.leaderName), `leaderName=${newTeam?.leaderName}`);

    // 원상 복원(display_order·description·leader).
    await sb.from("cluster4_team_halves").update({
      is_active: cap.is_active, display_order: cap.display_order,
      description: cap.description, leader_user_id: cap.leader_user_id, leader_crew_code: cap.leader_crew_code,
    }).eq("id", cap.id);
    await sb.from("cluster4_team_parts").update({ leader_user_id: cap.leader_user_id }).eq("team_half_id", cap.id).eq("part_name", "일반");
    const restored = await getInfo("encre", "test");
    check("복원 후 원래 카운트/목록", restored.teams.length === beforeCount && restored.teams.some((t: any) => t.teamName === target), `count=${restored.teams.length}`);
  }

  // ── 신규 비-(T) 테스트 팀 생성 — is_qa_test 컬럼(마이그레이션) 적용 후에만 ──
  const colProbe = await sb.from("cluster4_team_halves").select("is_qa_test").limit(1);
  const colPresent = !(colProbe.error && (colProbe.error as any).code === "42703");
  if (!colPresent) {
    console.log("\n=== [SKIP] 신규 팀 생성: is_qa_test 컬럼 미적용 → 마이그레이션 필요 ===");
    console.log("    db/migrations/2026-07-14_cluster4_team_halves_is_qa_test.sql 적용 후 재실행하세요.");
  } else {
    const NEW = "검증신규A", DIRECT_T = "검증직삽입T", DIRECT_O = "검증직삽입O";
    for (const org of ["encre", "oranke", "phalanx"]) {
      const crew = testCrews[org];
      console.log(`\n=== [${org}] 신규 비-(T) 팀 생성 + 스코프 각인 + 모드 격리 ===`);
      const cleanup = async () =>
        void (await sb.from("cluster4_team_halves").delete()
          .eq("organization_slug", org).eq("half_key", HALF)
          .in("team_name", [NEW, DIRECT_T, DIRECT_O]));
      await cleanup();
      const before = (await getInfo(org, "test")).teams.length;

      // (1) (T) 없는 새 이름을 test 모드로 등록 → 200 + is_qa_test=true 각인.
      const r = await register({ organization: org, halfKey: HALF, teamName: NEW, description: "신규 테스트 팀", leaderCrewCode: crew }, "test");
      check(`[${org}] 신규 비-(T) 팀 test 등록 → 200`, r.status === 200 && r.json?.success === true, `${r.status} ${r.json?.error ?? ""}`);
      const { data: row } = await sb.from("cluster4_team_halves").select("is_qa_test,is_active").eq("organization_slug", org).eq("half_key", HALF).eq("team_name", NEW).maybeSingle();
      check(`[${org}] DB is_qa_test=true 각인(팀명 아닌 mode)`, (row as any)?.is_qa_test === true && (row as any)?.is_active === true, JSON.stringify(row));
      const after = await getInfo(org, "test");
      check(`[${org}] 등록 직후 test 목록 노출(+1)`, after.teams.length === before + 1 && after.teams.some((t: any) => t.teamName === NEW), `${before}→${after.teams.length}`);
      check(`[${org}] 재조회(새로고침) 후에도 유지`, (await getInfo(org, "test")).teams.some((t: any) => t.teamName === NEW));

      // (2) DB 직삽입: 동일 스코프(test) 노출 / 타 스코프(operating) 미노출.
      await sb.from("cluster4_team_halves").insert([
        { organization_slug: org, half_key: HALF, team_name: DIRECT_T, display_order: 96, is_active: true, description: "직삽입 test", is_qa_test: true },
        { organization_slug: org, half_key: HALF, team_name: DIRECT_O, display_order: 97, is_active: true, description: "직삽입 operating", is_qa_test: false },
      ]);
      const view = await getInfo(org, "test");
      check(`[${org}] DB 직삽입 test 팀 → test 목록 노출`, view.teams.some((t: any) => t.teamName === DIRECT_T));
      check(`[${org}] DB 직삽입 operating 팀 → test 목록 미노출(모드 격리)`, !view.teams.some((t: any) => t.teamName === DIRECT_O));

      await cleanup();
      const cleaned = await getInfo(org, "test");
      check(`[${org}] 정리 후 원복`, cleaned.teams.length === before && !cleaned.teams.some((t: any) => [NEW, DIRECT_T, DIRECT_O].includes(t.teamName)), `count=${cleaned.teams.length}`);
    }

    // (3) 운영 모드 신규 팀 → is_qa_test=false 각인(QA_HIDE_REAL_USERS 미적용 시 경로 확인).
    //     현재 QA 고정(effectiveMode=test)이라 operating 등록은 test 로 각인됨을 direct 로 명시 검증.
    console.log("\n=== operating 각인 경로(resolveEffectiveScopeMode) 직접 확인 ===");
    const { resolveEffectiveScopeMode } = await import("@/lib/cluster4ExperienceTestScope");
    check("QA 고정: operating 요청도 실효 test", resolveEffectiveScopeMode("operating") === "test");
    check("QA 고정: test 요청 실효 test", resolveEffectiveScopeMode("test") === "test");
  }

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  if (fail > 0) process.exit(1);
}

async function allTestIds(): Promise<string[]> {
  const { resolveUserScope } = await import("@/lib/userScope");
  const s = await resolveUserScope("test", null);
  return Array.from(s.testUserIds) as string[];
}
async function lookupTestCrews(): Promise<Record<string, string>> {
  const ids = await allTestIds();
  const pick = async (org: string) => {
    const { data } = await sb.from("user_profiles").select("crew_code").eq("organization_slug", org).not("crew_code", "is", null).in("user_id", ids).limit(1).maybeSingle();
    const code = (data as any)?.crew_code;
    if (!code) throw new Error(`${org} test 크루 없음`);
    return code as string;
  };
  return { encre: await pick("encre"), oranke: await pick("oranke"), phalanx: await pick("phalanx") };
}
async function firstRealCrew(org: string, testIds: Set<string>): Promise<string | null> {
  const { data } = await sb.from("user_profiles").select("user_id,crew_code").eq("organization_slug", org).not("crew_code", "is", null).limit(50);
  const row = (data ?? []).find((p: any) => !testIds.has(p.user_id));
  return (row as any)?.crew_code ?? null;
}
async function isEncreTestCrew(code: string, testIds: Set<string>): Promise<boolean> {
  const { data } = await sb.from("user_profiles").select("user_id,organization_slug").eq("crew_code", code).maybeSingle();
  const r = data as any;
  return Boolean(r && r.organization_slug === "encre" && testIds.has(r.user_id));
}

main().catch((e) => { console.error(e); process.exit(1); });
