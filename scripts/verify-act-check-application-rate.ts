/**
 * 액트 체크 신청율 검증 — 불변식 + 목록/상세 파리티 + HTTP(일반/mode=test).
 * ─────────────────────────────────────────────────────────────────────
 *   1) 불변식(전 org × 전 주차)
 *   2) 목록(direct) == 상세(direct)   — 공통 빌더 사용 증명
 *   3) 목록(HTTP)   == 목록(direct)   — direct == HTTP
 *   4) 상세(HTTP)   == 상세(direct)
 *   5) 목록(HTTP)   == 상세(HTTP)     — 화면 간 수치 일치(요구 핵심)
 *   6) operating vs test — 구조 동일. 값은 변동 액트(scope_mode) 만큼만 달라질 수 있음.
 *   7) 케이스 커버리지 리포트(정규만/정규+변동/변동 미신청/가동 0/일부 가동)
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/verify-act-check-application-rate.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import { loadActCheckApplicationInputsByWeek } from "@/lib/adminActCheckApplicationInputs";
import type { ActCheckApplicationSummary } from "@/lib/actCheckApplicationSummary";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  if (!ok) console.log(`❌ ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
}
function eq(sum1: ActCheckApplicationSummary, sum2: ActCheckApplicationSummary): boolean {
  return JSON.stringify(sum1) === JSON.stringify(sum2);
}

async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: {
      getAll: () => [],
      setAll: (items: { name: string; value: string }[]) =>
        cap.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await sv.auth.setSession({ access_token: sess.access_token, refresh_token: sess.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 불변식 — 요구 명세 그대로.
async function assertInvariants(
  label: string,
  sum: ActCheckApplicationSummary,
  org: OrganizationSlug,
  weekId: string,
  mode: "operating" | "test",
) {
  const inputs = (await loadActCheckApplicationInputsByWeek({ weekIds: [weekId], organization: org, mode })).get(
    weekId,
  )!;
  const regularTotal = new Set(inputs.regular.map((r) => r.actId)).size;
  const activeRegular = inputs.regular.filter((r) => r.isActive).length;
  const variableCount = new Set(inputs.variable.map((v) => v.id)).size;

  check(`${label} totalCount === 정규전체 + 변동`, sum.totalCount === regularTotal + variableCount, {
    sum: sum.totalCount,
    regularTotal,
    variableCount,
  });
  check(`${label} activeCount === 가동정규 + 변동`, sum.activeCount === activeRegular + variableCount, {
    sum: sum.activeCount,
    activeRegular,
    variableCount,
  });
  check(
    `${label} activeCount === checked + unchecked`,
    sum.activeCount === sum.checkedCount + sum.uncheckedCount,
    sum,
  );
  check(`${label} checked <= active`, sum.checkedCount <= sum.activeCount, sum);
  check(`${label} variableCount 일치`, sum.variableCount === variableCount, {
    sum: sum.variableCount,
    variableCount,
  });
  const expected = sum.activeCount === 0 ? 0 : Math.round((sum.checkedCount / sum.activeCount) * 100);
  check(`${label} applicationRate 산식`, sum.applicationRate === expected, {
    rate: sum.applicationRate,
    expected,
  });
  if (variableCount > 0) {
    check(`${label} activeCount >= variableCount`, sum.activeCount >= variableCount, sum);
  }
  check(`${label} rate <= 100`, sum.applicationRate <= 100, sum);
}

type Case = { org: OrganizationSlug; weekId: string; weekName: string; sum: ActCheckApplicationSummary };

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }
  const cookie = await adminCookieHeader();
  const cases: Case[] = [];

  for (const org of ORGANIZATIONS as readonly OrganizationSlug[]) {
    // 전 주차(정렬 경로 = 전 주차 집계) — 불변식은 전수, 파리티는 데이터 있는 주차 위주.
    const listAll = await loadTeamPartsInfoWeeks({
      organization: org,
      page: 1,
      pageSize: 100,
      mode: "operating",
    });
    console.log(`\n── ${org} — 주차 ${listAll.items.length}개(1페이지) ──`);

    for (const it of listAll.items) {
      await assertInvariants(`[${org}/${it.weekName}] 목록`, it.actCheck, org, it.weekId, "operating");
      cases.push({ org, weekId: it.weekId, weekName: it.weekName, sum: it.actCheck });
    }

    // 데이터가 있는(체크 또는 변동 존재) 주차 + 대표 몇 개를 상세와 대조(상세는 주차당 무거움).
    const interesting = listAll.items
      .filter((it) => it.actCheck.checkedCount > 0 || it.actCheck.variableCount > 0)
      .slice(0, 6);
    const sample = interesting.length ? interesting : listAll.items.slice(0, 2);

    for (const it of sample) {
      const det = await loadTeamPartsInfoActCheckManagement({
        weekId: it.weekId,
        organization: org,
        mode: "operating",
      });
      // (2) 목록(direct) == 상세(direct)
      check(`[${org}/${it.weekName}] 목록(direct) == 상세(direct)`, eq(it.actCheck, det.summary), {
        list: it.actCheck,
        detail: det.summary,
      });
      await assertInvariants(`[${org}/${it.weekName}] 상세`, det.summary, org, it.weekId, "operating");

      // 상세 허브 합 ⊇ 정합: 허브별 정규 합 == 주차 전체 정규(변동은 info 귀속 1회만).
      const hubRegularSum =
        det.clubOverall.summary.totalCount +
        (det.practicalInfo.summary.totalCount - det.practicalInfo.summary.variableCount) +
        det.practicalExperience.summary.totalCount +
        det.practicalCompetency.summary.totalCount;
      check(
        `[${org}/${it.weekName}] 허브 정규 합 == 주차 전체 정규`,
        hubRegularSum === det.summary.totalCount - det.summary.variableCount,
        { hubRegularSum, weekRegular: det.summary.totalCount - det.summary.variableCount },
      );

      // (4) 상세 HTTP == 상세 direct
      const dRes = await fetch(
        `${BASE}/api/admin/team-parts/info/weeks/${it.weekId}/act-check-management?club=${org}`,
        { headers: { cookie }, cache: "no-store" },
      );
      if (dRes.ok) {
        const dJson = (await dRes.json()) as { data?: { summary?: ActCheckApplicationSummary } };
        if (dJson.data?.summary) {
          check(`[${org}/${it.weekName}] 상세 HTTP == direct`, eq(dJson.data.summary, det.summary), {
            http: dJson.data.summary,
            direct: det.summary,
          });
          // (5) 목록 HTTP == 상세 HTTP 는 아래 목록 HTTP 확보 후 비교.
        }
      }
    }

    // (3) 목록 HTTP == 목록 direct + (5) 목록 HTTP == 상세
    const lRes = await fetch(
      `${BASE}/api/admin/team-parts/info/weeks?club=${org}&page=1&pageSize=100`,
      { headers: { cookie }, cache: "no-store" },
    );
    check(`[${org}] 목록 HTTP 200`, lRes.ok, { status: lRes.status });
    if (lRes.ok) {
      const lJson = (await lRes.json()) as { data: { items: Array<{ weekId: string; actCheck: ActCheckApplicationSummary }> } };
      for (const it of listAll.items) {
        const h = lJson.data.items.find((x) => x.weekId === it.weekId);
        check(`[${org}/${it.weekName}] 목록 HTTP == direct`, !!h && eq(h.actCheck, it.actCheck), {
          http: h?.actCheck,
          direct: it.actCheck,
        });
      }
    }

    // (6) operating vs test — 구조 동일(키셋). 값 차이는 변동 액트 스코프에서만 허용.
    const listTest = await loadTeamPartsInfoWeeks({
      organization: org,
      page: 1,
      pageSize: 100,
      mode: "test",
    });
    for (const it of listAll.items) {
      const t = listTest.items.find((x) => x.weekId === it.weekId);
      if (!t) {
        check(`[${org}/${it.weekName}] test 주차 존재`, false);
        continue;
      }
      check(
        `[${org}/${it.weekName}] operating/test DTO 키셋 동일`,
        Object.keys(it.actCheck).sort().join(",") === Object.keys(t.actCheck).sort().join(","),
      );
      // 정규 부분(전체−변동, 가동−변동)은 mode 무관이어야 한다.
      check(
        `[${org}/${it.weekName}] 정규 전체는 mode 불변`,
        it.actCheck.totalCount - it.actCheck.variableCount ===
          t.actCheck.totalCount - t.actCheck.variableCount,
        { op: it.actCheck, test: t.actCheck },
      );
      check(
        `[${org}/${it.weekName}] 정규 가동은 mode 불변`,
        it.actCheck.activeCount - it.actCheck.variableCount ===
          t.actCheck.activeCount - t.actCheck.variableCount,
        { op: it.actCheck, test: t.actCheck },
      );
    }
  }

  // (7) 케이스 커버리지
  console.log("\n═══ 케이스 커버리지 ═══");
  const withVar = cases.filter((c) => c.sum.variableCount > 0);
  const varUnchecked = cases.filter((c) => c.sum.variableCount > 0 && c.sum.uncheckedCount > 0);
  const regularOnly = cases.filter((c) => c.sum.variableCount === 0 && c.sum.totalCount > 0);
  const zeroActive = cases.filter((c) => c.sum.activeCount === 0);
  const someChecked = cases.filter((c) => c.sum.checkedCount > 0 && c.sum.checkedCount < c.sum.activeCount);
  const fmt = (n: number, label: string) => `  ${n > 0 ? "✓" : "—"} ${label}: ${n}`;
  console.log(fmt(regularOnly.length, "정규만 있는 주차"));
  console.log(fmt(withVar.length, "정규+변동 있는 주차"));
  console.log(fmt(varUnchecked.length, "변동 있고 미체크 존재"));
  console.log(fmt(zeroActive.length, "가동 0 주차"));
  console.log(fmt(someChecked.length, "일부만 체크된 주차"));
  for (const c of withVar.slice(0, 8)) {
    console.log(
      `     ${c.org}/${c.weekName}: 전체=${c.sum.totalCount} 가동=${c.sum.activeCount} 체크=${c.sum.checkedCount} 미체크=${c.sum.uncheckedCount} 변동=${c.sum.variableCount} 율=${c.sum.applicationRate}%`,
    );
  }

  console.log(`\n═══ 결과: PASS ${passed} · FAIL ${failed} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
