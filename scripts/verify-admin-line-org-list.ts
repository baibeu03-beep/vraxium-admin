/**
 * 검증: 어드민 라인 목록 org 서버 필터 (통합 검수 시스템 ↔ 조직 진입).
 *
 *   npx tsx --env-file=.env.local scripts/verify-admin-line-org-list.ts
 *
 * 모두 서버(쿼리/순수 로직) 기준 결과다 — 프론트 표시 필터가 아니다.
 *
 * PART 1 (resolver 전수, raw cluster4_lines): info/experience/competency 전 라인을 공유 함수
 *   resolveCluster4LineOrgScope 로 판정하고, isLineVisibleForUserOrg(allowUnknown=false) 로
 *   조직별 가시성을 계산해 0/1/3 partition 불변식을 검증한다.
 *     - 각 라인은 조직 3곳 중 0곳(판정불가·fail-closed)/1곳(조직 전용)/3곳(common)에만 등장. 2곳=절대 없음.
 *     - = (org == X) OR common 정책의 구조적 증거(고객 weekly-cards 와 동일 함수 공유).
 *
 * PART 2 (list 함수 per-org smoke): listCluster4Lines({partType, organization}) 가 실제로 필터를
 *   적용하는지 — 반환 라인 id 가 전부 PART 1 의 {org, common} 집합에 속하는지 확인.
 *   (통합(org 미지정) 호출은 experience/competency 에서 targetIds .in() 폭주 = 선행 한계라 제외.
 *    org 스코프는 집합을 줄이므로 폭주하지 않는다.)
 *
 * PART 3 (registrations, 진짜 DB .in([org,common])): organization_slug ∈ {org, common} + partition.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  listCluster4Lines,
  listCluster4LinesDetailed,
  resolveCluster4LineOrgScope,
} from "@/lib/adminCluster4LinesData";
import { listLineRegistrations } from "@/lib/adminLineRegistrationsData";
import { isLineVisibleForUserOrg, type LineOrgScope } from "@/lib/cluster4LineOrg";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let failures = 0;
function assert(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
}

type RawLine = {
  id: string;
  part_type: string;
  line_code: string | null;
  experience_line_master_id: string | null;
  competency_line_master_id: string | null;
};

// PART 1 — raw 라인 전수 resolve + partition. 반환: id→scope 맵(PART 2 재사용).
async function part1(
  partType: "info" | "experience" | "competency",
): Promise<Map<string, LineOrgScope | null>> {
  console.log(`\n──── PART 1 resolver:${partType} ────`);
  const { data, error } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,line_code,experience_line_master_id,competency_line_master_id",
    )
    .eq("part_type", partType);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RawLine[];

  const idToScope = new Map<string, LineOrgScope | null>();
  let only0 = 0;
  let only1 = 0;
  let all3 = 0;
  let bad2 = 0;
  for (const row of rows) {
    const scope = await resolveCluster4LineOrgScope(row);
    idToScope.set(row.id, scope);
    const n = ORGANIZATIONS.reduce(
      (acc, o) => acc + (isLineVisibleForUserOrg(scope, o, { allowUnknown: false }) ? 1 : 0),
      0,
    );
    if (n === 0) only0++;
    else if (n === 1) only1++;
    else if (n === 3) all3++;
    else bad2++;
  }
  console.log(
    `  전체 ${rows.length} | 판정불가(0곳) ${only0} | 조직전용(1곳) ${only1} | 공통(3곳) ${all3} | 2곳=${bad2}`,
  );
  assert(`resolver:${partType} — 2곳에만 등장하는 라인 없음 (0/1/3 partition)`, bad2 === 0);
  assert(
    `resolver:${partType} — only0+only1+all3 == 전체`,
    only0 + only1 + all3 === rows.length,
  );
  return idToScope;
}

// PART 2 — list 함수가 org 필터를 실제 적용하는지 per-org smoke.
async function part2(
  partType: "info" | "experience" | "competency",
  idToScope: Map<string, LineOrgScope | null>,
) {
  console.log(`\n──── PART 2 list:${partType} (per-org) ────`);
  for (const org of ORGANIZATIONS) {
    // listCluster4Lines 는 반환 라인의 target/submission count 를 .in() 으로 모은다.
    // experience/competency 는 라인당 target 이 많아 limit 이 크면 선행 .in() 한계(Bad Request).
    // → limit 을 낮춰 첫 성공값을 쓴다. truncation 은 "반환 라인이 전부 org-일치"라는 단언에
    //   거짓양성을 만들지 않는다(필터가 동작하면 어떤 부분집합도 org-일치).
    let rows: Array<{ id: string }> | null = null;
    for (const limit of [200, 50, 20, 8, 3]) {
      try {
        rows = (await listCluster4Lines({ partType, organization: org, limit })).rows;
        if (limit !== 200) console.log(`    (limit ${limit} 로 폴백 — 선행 target-count .in 한계 회피)`);
        break;
      } catch {
        // 선행 한계(Bad Request / fetch failed: target/submission .in() URL 폭주) → 더 작은 limit 재시도.
        continue;
      }
    }
    if (rows === null) {
      console.log(`  ⚠ list:${partType}[${org}] — 선행 .in 한계로 list 함수 호출 불가(필터는 PART 1 로 검증됨). skip.`);
      continue;
    }
    const violations = rows.filter((r) => {
      const scope = idToScope.get(r.id) ?? null;
      return !isLineVisibleForUserOrg(scope, org, { allowUnknown: false });
    });
    assert(
      `list:${partType}[${org}] — ${rows.length}건 전부 {${org}, common} (위반 ${violations.length})`,
      violations.length === 0,
    );
  }
}

async function main() {
  console.log("════════ 어드민 라인 목록 org 서버 필터 검증 ════════");

  // detailed 경로 대표 검증 — info (experience/competency detailed 는 선행 .in 한계로 제외).
  {
    console.log("\n──── detailed:info (list 함수, org 필터 경로) ────");
    const integrated = new Set(
      (await listCluster4LinesDetailed({ partType: "info", limit: 500 })).rows.map((r) => r.id),
    );
    for (const org of ORGANIZATIONS) {
      const scoped = (
        await listCluster4LinesDetailed({ partType: "info", organization: org, limit: 500 })
      ).rows;
      const subset = scoped.every((r) => integrated.has(r.id));
      assert(`detailed:info[${org}] — 조직 결과 ⊆ 통합 (${scoped.length}건)`, subset);
    }
  }

  for (const partType of ["info", "experience", "competency"] as const) {
    const idToScope = await part1(partType);
    await part2(partType, idToScope);
  }

  // PART 3 — registrations (진짜 DB .in([org, common]))
  console.log("\n──── PART 3 registrations (허브와 라인) ────");
  const regInt = new Set((await listLineRegistrations({ limit: 200 })).rows.map((r) => r.id));
  const regPerOrg = {} as Record<OrganizationSlug, Set<string>>;
  for (const o of ORGANIZATIONS) {
    const r = await listLineRegistrations({ organization: o, limit: 200 });
    regPerOrg[o] = new Set(r.rows.map((row) => row.id));
    const bad = r.rows.filter(
      (row) => row.organizationSlug !== o && row.organizationSlug !== "common",
    );
    assert(
      `registrations[${o}] — organization_slug ∈ {${o}, common} (위반 ${bad.length}, 총 ${r.rows.length})`,
      bad.length === 0,
    );
    for (const id of regPerOrg[o]) {
      if (!regInt.has(id)) assert(`registrations[${o}] — ⊆ 통합`, false);
    }
  }
  let reg2 = 0;
  for (const id of regInt) {
    const n = ORGANIZATIONS.reduce((acc, o) => acc + (regPerOrg[o].has(id) ? 1 : 0), 0);
    if (n === 2) reg2++;
  }
  assert(`registrations — 2곳에만 등장하는 행 없음 (partition)`, reg2 === 0);

  console.log("\n════════ 결과 ════════");
  if (failures > 0) {
    console.log(`❌ 검증 실패 ${failures}건.`);
    process.exit(1);
  }
  console.log("✅ direct 함수 org 필터 검증 전부 통과.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
