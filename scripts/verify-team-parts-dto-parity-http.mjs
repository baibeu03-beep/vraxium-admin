/**
 * DTO 동등성 검증 — /admin/team-parts/info 계열, 2개 이상 조직 × 여러 주차 × mode(operating/test).
 *   read-only(쓰기 없음) — DB 상태를 건드리지 않는다.
 *   actAsTestUserId/demoUserId 는 이 라우트 계열에 구현되어 있지 않음을 코드로 확인(grep) 후,
 *   여기서는 organic 하게 적용되는 축(org × mode)만 비교한다.
 * 사전조건: dev :3000. Usage: node scripts/verify-team-parts-dto-parity-http.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

let fail = 0;
let pass = 0;
const ck = (l, ok, d = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

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

async function main() {
  const cookie = await cookieHeader();
  const call = (path) => fetch(`${ADMIN}${path}`, { headers: { cookie }, cache: "no-store" }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

  const snapBefore = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  console.log("snapshot 테이블 행수(사전):", snapBefore.count);

  const ORGS = ["encre", "oranke"];
  for (const ORG of ORGS) {
    console.log(`\n=== ${ORG} ===`);
    const { data: th } = await sb
      .from("cluster4_team_halves")
      .select("id,team_name,half_key,is_qa_test")
      .eq("organization_slug", ORG)
      .eq("half_key", "2026-H2") // 현재 반기만 — 과거 반기 팀은 team-detail 조회 대상이 아니다(별도 정책).
      .eq("is_active", true)
      .order("display_order")
      .limit(4);
    if (!th || th.length === 0) {
      console.log("팀 없음, 스킵");
      continue;
    }
    for (const team of th.slice(0, 2)) {
      const mode = team.is_qa_test ? "test" : "operating";
      // ⚠ 이 환경은 QA_HIDE_REAL_USERS=true(lib/qaFixedScope.ts, 2026-07-01~QA 종료 프로젝트 공식
      //   스위치) — "operating" mode 를 요청해도 사람/팀 모집단은 항상 test 로 강제 고정된다(이번
      //   수정과 무관한 기존 정책). 그래서 진짜 운영 팀(is_qa_test=false)은 mode=operating 으로도
      //   404 가 정상이다 — "반대 스코프 교차 조회" 비교 대신, **mode 파라미터 유무에 따라 DTO 가
      //   달라지지 않는지**(라우트가 이 스위치를 일관되게 적용하는지)를 검증한다.
      const [top, noParam] = await Promise.all([
        call(`/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&half=${team.half_key}&mode=${mode}`),
        call(`/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&half=${team.half_key}`),
      ]);
      if (team.is_qa_test) {
        ck(`[${ORG}/${team.team_name}] mode=${mode}(자기 스코프) team-detail 200`, top.status === 200 && top.j?.success, top.j?.error);
        ck(
          `[${ORG}/${team.team_name}] QA_HIDE_REAL_USERS 기간 — mode 파라미터 없어도(기본 operating) 동일 결과(강제 test)`,
          noParam.status === top.status && JSON.stringify(noParam.j?.data) === JSON.stringify(top.j?.data),
        );
      } else {
        ck(`[${ORG}/${team.team_name}] 운영 팀은 QA 기간 중 mode 무관 404(강제 test 모집단, 정책대로)`, noParam.status === 404);
      }
      if (top.status === 200) {
        const d = top.j.data;
        const expectedKeys = [
          "organization",
          "currentHalfKey",
          "selectedHalfKey",
          "editable",
          "halves",
          "currentDate",
          "currentWeek",
          "currentWeekStartDate",
          "team",
          "currentCrew",
          "generatedParts",
          "operatedPartCount",
          "maxCreatedParts",
          "selectedTeam",
          "weekColumns",
        ];
        const missing = expectedKeys.filter((k) => !(k in d));
        ck(`[${ORG}/${team.team_name}] team-detail DTO 최상위 키 전부 존재`, missing.length === 0, missing);

        // week-summary — 현재 주차(weekId 미지정) + 과거 주차 1개(있으면).
        const ws1 = await call(`/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${mode}`);
        ck(`[${ORG}/${team.team_name}] week-summary 200`, ws1.status === 200 && ws1.j?.success, ws1.j?.error);
        const wsExpectedKeys = ["selectableWeeks", "week", "crew", "growth", "operatedParts", "crewRows"];
        const wsMissing = wsExpectedKeys.filter((k) => !(k in (ws1.j?.data ?? {})));
        ck(`[${ORG}/${team.team_name}] week-summary DTO 최상위 키 전부 존재`, wsMissing.length === 0, wsMissing);

        const selWeeks = ws1.j?.data?.selectableWeeks ?? [];
        if (selWeeks.length >= 2) {
          const pastWeek = selWeeks[1]; // 최신순 정렬 — [0]=현재, [1]=바로 이전.
          const ws2 = await call(
            `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${mode}&weekId=${pastWeek.weekId}`,
          );
          ck(`[${ORG}/${team.team_name}] 과거 주차(${pastWeek.label}) week-summary 200`, ws2.status === 200 && ws2.j?.success);
          ck(
            `[${ORG}/${team.team_name}] 과거 주차 응답의 week.weekId == 요청 weekId(폴백 없음)`,
            ws2.j?.data?.week?.weekId === pastWeek.weekId,
            { requested: pastWeek.weekId, got: ws2.j?.data?.week?.weekId },
          );
          // operatedParts 는 항상 crewRows 로부터 파생 가능한 집합 이하(파트별 distinct 크루) — 불변식.
          const opNames = new Set((ws2.j?.data?.operatedParts ?? []).map((p) => p.partName));
          const rowParts = new Set((ws2.j?.data?.crewRows ?? []).map((r) => r.rawPart).filter(Boolean));
          // crewRows 는 집합②(더 좁음)라 crewRows 의 파트는 항상 operatedParts(집합①) 부분집합이어야 한다.
          const subsetOk = [...rowParts].every((p) => opNames.has(p));
          ck(`[${ORG}/${team.team_name}] crewRows 파트 ⊆ operatedParts(집합② ⊆ 집합①)`, subsetOk, { rowParts: [...rowParts], opNames: [...opNames] });
        }

        // matrix(존재표) — team-detail 응답에 이미 포함(selectedTeam.partWeekMatrix).
        const matrix = d.selectedTeam?.partWeekMatrix;
        ck(`[${ORG}/${team.team_name}] partWeekMatrix 존재`, Boolean(matrix), matrix);
        if (matrix) {
          ck(
            `[${ORG}/${team.team_name}] matrix.present 각 행 길이 == weekColumns 길이`,
            matrix.present.every((row) => row.length === d.weekColumns.length),
          );
        }
      }
    }
  }

  const snapAfter = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  console.log("\nsnapshot 테이블 행수(사후):", snapAfter.count);
  ck("snapshot 테이블 행수 불변(read-only 검증이므로 증감 없어야 함)", snapBefore.count === snapAfter.count, {
    before: snapBefore.count,
    after: snapAfter.count,
  });

  console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
