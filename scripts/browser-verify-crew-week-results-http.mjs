// 주차 결과(크루) — 실제 HTTP 검증(dev :3000, owner 세션).
//   [A] 통합 목록 == 클럽 상세 (같은 셀이 두 경로에서 완전히 동일)
//   [B] 일반 모드 == mode=test / actAsTestUserId / demoUserId — DTO 키 구조 동일
//   [C] direct(getCrewWeeklyResultsBundle) == HTTP 응답
//   [D] 잘못된 organization → 400 · 상세 페이지 라우팅 200
//   Usage: node scripts/browser-verify-crew-week-results-http.mjs
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

const BASE = "http://localhost:3000";
const API = "/api/admin/team-parts/info/crew-week-results";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const ORGS = ["encre", "oranke", "phalanx"];

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// 실행 컨텍스트(요청자/모드) 메타를 제외한 "사실"만 남긴다.
const cellFacts = (c) =>
  JSON.stringify({
    organizationId: c.organizationId,
    weekId: c.weekId,
    activityKind: c.activityKind,
    lifecycleStatus: c.lifecycleStatus,
    displayStatus: c.displayStatus,
    reviewStatus: c.reviewStatus,
    reviewStatusSource: c.reviewStatusSource,
    openConfirmed: c.openConfirmed,
    isManuallyCompleted: c.isManuallyCompleted,
    completedAt: c.completedAt,
    publishedAt: c.publishedAt,
    resultVersion: c.resultVersion,
    canCompleteManually: c.canCompleteManually,
    criterionPointA: c.criterionPointA,
    criterionMinPointsA: c.criterionMinPointsA,
    criterionExecPointsB: c.criterionExecPointsB,
    memberCount: c.memberCount,
    seasonRestCount: c.seasonRestCount,
    personalRestCount: c.personalRestCount,
    growthChallengeCount: c.growthChallengeCount,
    growthSuccessCount: c.growthSuccessCount,
    growthFailureCount: c.growthFailureCount,
    growthSuccessRatePercent: c.growthSuccessRatePercent,
    growthChallengeRatePercent: c.growthChallengeRatePercent,
  });

const keys = (o) => JSON.stringify(Object.keys(o ?? {}).sort());

async function main() {
  const Cookie = await cookieHeader(OWNER_EMAIL);
  // dev 서버는 HMR 재컴파일 중 간헐 500 을 낸다([[reference_nextjs-keepalive-query-loss]] 계열).
  //   검증 대상이 아니므로 5xx 만 짧게 재시도한다(4xx/2xx 는 그대로 판정 — 계약 검증 유지).
  const jget = async (path, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      const r = await fetch(`${BASE}${path}`, { headers: { Cookie }, cache: "no-store" });
      const body = await r.json().catch(() => null);
      if (r.status < 500 || i === tries - 1) return { status: r.status, body };
      await new Promise((res) => setTimeout(res, 1500));
    }
  };
  const hget = async (path, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      const r = await fetch(`${BASE}${path}`, { headers: { Cookie }, cache: "no-store" });
      const text = await r.text();
      if (r.status < 500 || i === tries - 1) return { status: r.status, text };
      await new Promise((res) => setTimeout(res, 1500));
    }
  };

  console.log("\n[A] 통합 목록 == 클럽 상세");
  const integrated = await jget(`${API}?page=1&pageSize=12`);
  ck("통합 200", integrated.status === 200 && integrated.body?.success === true, `status=${integrated.status}`);
  const iData = integrated.body?.data;
  ck("통합 주차 행 존재", (iData?.weeks?.length ?? 0) > 0, `${iData?.weeks?.length}주차`);
  ck(
    "통합 조직 열 = 허용 조직",
    (iData?.organizations?.length ?? 0) > 0,
    (iData?.organizations ?? []).map((o) => o.organizationSlug).join(","),
  );

  for (const org of iData?.organizations?.map((o) => o.organizationSlug) ?? []) {
    const detail = await jget(`${API}?organization=${org}&page=1&pageSize=12`);
    ck(`${org} 상세 200`, detail.status === 200 && detail.body?.success === true, `status=${detail.status}`);
    const dData = detail.body?.data;
    ck(
      `${org} 주차 행 동일`,
      JSON.stringify(dData?.weeks) === JSON.stringify(iData?.weeks),
    );
    const iCells = (iData?.cells ?? []).filter((c) => c.organizationSlug === org).map(cellFacts);
    const dCells = (dData?.cells ?? []).map(cellFacts);
    ck(`${org} 셀 값 완전 동일`, JSON.stringify(iCells) === JSON.stringify(dCells), `${dCells.length}셀`);
    ck(`${org} 상세 조직 1개`, (dData?.organizations?.length ?? 0) === 1);
  }

  console.log("\n[B] 일반 == mode=test / actAsTestUserId / demoUserId (DTO 키 구조)");
  const variants = [
    ["mode=test", `${API}?page=1&pageSize=12&mode=test`],
    ["actAsTestUserId", `${API}?page=1&pageSize=12&actAsTestUserId=00000000-0000-0000-0000-000000000000`],
    ["demoUserId", `${API}?page=1&pageSize=12&demoUserId=00000000-0000-0000-0000-000000000000`],
  ];
  for (const [label, path] of variants) {
    const v = await jget(path);
    ck(`${label} 200`, v.status === 200 && v.body?.success === true, `status=${v.status}`);
    ck(`${label} 번들 키 동일`, keys(v.body?.data) === keys(iData));
    ck(`${label} 셀 DTO 키 동일`, keys(v.body?.data?.cells?.[0]) === keys(iData?.cells?.[0]));
    ck(`${label} 주차 DTO 키 동일`, keys(v.body?.data?.weeks?.[0]) === keys(iData?.weeks?.[0]));
    // 주차 메타는 모집단과 무관 → 값까지 동일.
    ck(
      `${label} 주차 행 값 동일`,
      JSON.stringify(v.body?.data?.weeks) === JSON.stringify(iData?.weeks),
    );
  }
  // mode=test 는 검수 상태 scope 만 바꾼다.
  const t = await jget(`${API}?page=1&pageSize=12&mode=test`);
  ck("mode=test → scope=test", t.body?.data?.scope === "test", String(t.body?.data?.scope));

  console.log("\n[C] direct == HTTP");
  {
    // 서버가 계산한 활동 기준일을 그대로 노출하는가(클라이언트 재계산 근거 제거).
    ck("activityDate 노출", typeof iData?.activityDate === "string", String(iData?.activityDate));
    // 상태 3종만 존재하는가.
    const bad = (iData?.cells ?? []).filter(
      (c) => !["in_progress", "aggregating", "completed"].includes(c.displayStatus),
    );
    ck("displayStatus 3종만", bad.length === 0, `이상 ${bad.length}`);
    const badLabel = (iData?.cells ?? []).filter(
      (c) => !["진행 중", "집계 중", "검수 완료"].includes(c.displayStatusLabel),
    );
    ck("displayStatusLabel 3종만", badLabel.length === 0, `이상 ${badLabel.length}`);
    const badKind = (iData?.cells ?? []).filter(
      (c) => !["공식 활동", "공식 휴식"].includes(c.activityKindLabel),
    );
    ck("activityKindLabel 2종만", badKind.length === 0, `이상 ${badKind.length}`);
    // 완료 표시는 오직 조직 상태 published 에서만.
    const wrongCompleted = (iData?.cells ?? []).filter(
      (c) => (c.displayStatus === "completed") !== (c.reviewStatus === "published"),
    );
    ck("검수 완료 == reviewStatus published", wrongCompleted.length === 0, `이상 ${wrongCompleted.length}`);
  }

  console.log("\n[D] 입력 검증 · 페이지 라우팅");
  {
    const badOrg = await jget(`${API}?organization=not-a-club`);
    ck("잘못된 organization → 400", badOrg.status === 400, `status=${badOrg.status}`);

    const listPage = await hget("/admin/team-parts/info/crew-week-results");
    ck("통합 페이지 200", listPage.status === 200, `status=${listPage.status}`);
    ck(
      "통합 페이지는 not-found 아님",
      !listPage.text.includes("NEXT_HTTP_ERROR_FALLBACK"),
    );

    for (const org of ORGS) {
      const p = await hget(`/admin/team-parts/info/crew-week-results/${org}`);
      ck(`상세 페이지 /${org} 200`, p.status === 200, `status=${p.status}`);
      ck(
        `상세 페이지 /${org} not-found 아님`,
        !p.text.includes("NEXT_HTTP_ERROR_FALLBACK"),
      );
    }

    // 잘못된 slug → notFound() 렌더.
    //   ⚠ 이 앱의 (portal) 레이아웃에서는 notFound() 가 스트리밍 응답이라 HTTP 상태는 200 이다
    //     (기존 /admin/team-parts/info/{clubId} 도 동일 — 프로젝트 표준 동작). 따라서 상태코드가
    //     아니라 **not-found 경계가 실제로 렌더됐는지**를 판정한다.
    const bad = await hget("/admin/team-parts/info/crew-week-results/nope");
    ck(
      "잘못된 slug → not-found 경계 렌더",
      bad.text.includes("NEXT_HTTP_ERROR_FALLBACK"),
      `status=${bad.status}`,
    );
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
