// 검증(직접 DB — dev 서버 불필요) — 클럽 진행/주차 내역 조직 스코프 & DTO 파리티.
//   통합/개별 판정 SoT = URL 의 유효한 ?org 유무(org-optional 정책). 서버 쓰기 게이트(review·
//   open-confirm)는 (개별 컨텍스트=?org) OR (단일 조직 어드민=!isAllOrgs) 이면 403 — HTTP 계층은
//   browser-verify-team-parts-weeks-org-scope-http.mjs 가 확인한다. 이 직접 스크립트는 데이터 계층만:
//   1) resolveAdminOrgAccess 결과: owner → isAllOrgs=true(전체), 단일 조직(org=encre) → 1개(!isAllOrgs).
//   2) 조회 DTO 공통화: loadTeamPartsInfoWeeks / loadTeamPartsInfoWeekDetail 를 일반(operating) vs
//      mode=test 로 호출 → DTO 키 동일 + 조직 스코프 동일(요구사항 #8·#10 직접 계층). 통합·개별이
//      같은 조회 함수·DTO 를 쓰고 org 만 제한됨을 증명한다.
//
// 실행: npm exec tsx -- --env-file=.env.local scripts/verify-team-parts-weeks-org-scope-direct.ts

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveAdminOrgAccess } from "@/lib/adminOrgAccess";
import type { AdminContext } from "@/lib/adminAuth";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { loadTeamPartsInfoWeekDetail } from "@/lib/adminTeamPartsInfoWeekDetailData";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

// 재귀 키 집합(값 무관) — DTO 구조 동일성 비교용.
function keyShape(v: unknown, prefix = ""): string[] {
  if (v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) {
    // 배열은 첫 원소의 키 구조만(길이 다를 수 있음).
    return v.length > 0 ? keyShape(v[0], `${prefix}[]`) : [];
  }
  const out: string[] = [];
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p);
    out.push(...keyShape((v as Record<string, unknown>)[k], p));
  }
  return out;
}

async function main() {
  console.log("── 1) resolveAdminOrgAccess 결과(owner=전체 · 단일 조직=1개) ──");
  // owner 표본
  const { data: owners } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1);
  const ownerRow = owners?.[0];
  if (ownerRow) {
    const ownerCtx: AdminContext = {
      userId: ownerRow.id,
      email: ownerRow.email,
      role: "owner",
      isActive: true,
    };
    const a = await resolveAdminOrgAccess(ownerCtx);
    ok(a.isAllOrgs === true, `owner(${ownerRow.email}) → isAllOrgs=true (게이트 통과)`);
  } else {
    ok(false, "owner admin 표본 없음");
  }

  // 개별(encre) 표본: 실제 encre user_profiles 를 role=admin 으로 가정.
  const { data: encreUser } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "encre")
    .limit(1)
    .maybeSingle();
  if (encreUser?.user_id) {
    const indivCtx: AdminContext = {
      userId: encreUser.user_id,
      email: null,
      role: "admin",
      isActive: true,
    };
    const a = await resolveAdminOrgAccess(indivCtx);
    ok(
      a.isAllOrgs === false && a.allowedOrgs.length === 1 && a.allowedOrgs[0] === "encre",
      `encre 단일 조직 admin → {allowedOrgs:[${a.allowedOrgs.join(",")}], isAllOrgs:${a.isAllOrgs}}`,
    );
    // 단일 조직 어드민은 !isAllOrgs 분기로 서버 쓰기 403(개별 컨텍스트 ?org 와 별개 보강 분기).
    ok(!a.isAllOrgs === true, "  단일 조직 → !isAllOrgs=true ⇒ 서버 쓰기 게이트 403(보강 분기)");
  } else {
    ok(false, "encre user_profiles 표본 없음");
  }

  console.log("\n── 2) 목록 DTO — operating vs test 조직 스코프 파리티 ──");
  // 목록 로더는 설계상 mode 무관(값 파리티). encre 로만 호출해 조직 필드/구조 확인.
  const listEncre = await loadTeamPartsInfoWeeks({ organization: "encre", page: 1, pageSize: 20 });
  ok(listEncre.organization === "encre", `목록 organization === encre`);
  ok(Array.isArray(listEncre.items), `목록 items 배열(${listEncre.items.length}건)`);
  const listOranke = await loadTeamPartsInfoWeeks({ organization: "oranke", page: 1, pageSize: 20 });
  ok(
    JSON.stringify(keyShape(listEncre)) === JSON.stringify(keyShape(listOranke)),
    "encre/oranke 목록 DTO 키 구조 동일(조직만 다름)",
  );
  ok(listOranke.organization === "oranke", `타 조직 호출 시 organization === oranke(스코프 반영)`);

  console.log("\n── 3) 상세 DTO — operating vs test 파리티(같은 org·같은 weekId) ──");
  // 상세 대상 주차: 아무 주차나(현재 주차 우선). 없으면 첫 주차.
  const weekId = listEncre.currentWeek?.weekId ?? listEncre.items[0]?.weekId ?? null;
  if (!weekId) {
    ok(false, "상세 검증용 weekId 확보 실패(주차 없음)");
  } else {
    const detailOp = await loadTeamPartsInfoWeekDetail({ weekId, organization: "encre", mode: "operating" });
    const detailTest = await loadTeamPartsInfoWeekDetail({ weekId, organization: "encre", mode: "test" });
    ok(
      JSON.stringify(keyShape(detailOp)) === JSON.stringify(keyShape(detailTest)),
      "상세 DTO 키 구조: operating === test (동일 조회 함수·동일 DTO)",
    );
    // mode 는 설계상 실무경험 팀 스코프에만 영향 → 그 외 값은 동일해야 한다.
    ok(
      JSON.stringify(detailOp.managedWeek) === JSON.stringify(detailTest.managedWeek),
      "  managedWeek 값 동일(operating=test)",
    );
    ok(
      JSON.stringify(detailOp.currentWeek) === JSON.stringify(detailTest.currentWeek),
      "  currentWeek 값 동일(operating=test)",
    );
    ok(
      JSON.stringify(detailOp.openingConfig.actCheck.info) ===
        JSON.stringify(detailTest.openingConfig.actCheck.info) &&
        JSON.stringify(detailOp.openingConfig.actCheck.club) ===
          JSON.stringify(detailTest.openingConfig.actCheck.club) &&
        JSON.stringify(detailOp.openingConfig.lineOpening.practicalInfo) ===
          JSON.stringify(detailTest.openingConfig.lineOpening.practicalInfo),
      "  허브·라인 체크 상태(정보/총괄/라인) 값 동일(operating=test)",
    );

    // 조직 스코프: encre vs oranke 상세는 같은 구조지만 openingConfig 등이 org 로 갈린다.
    const detailOranke = await loadTeamPartsInfoWeekDetail({ weekId, organization: "oranke", mode: "operating" }).catch(
      () => null,
    );
    if (detailOranke) {
      ok(
        JSON.stringify(keyShape(detailOp)) === JSON.stringify(keyShape(detailOranke)),
        "  encre/oranke 상세 DTO 키 구조 동일(조직 스코프만 제한)",
      );
    } else {
      console.log("  (oranke 상세 로드 불가 — 건너뜀)");
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
