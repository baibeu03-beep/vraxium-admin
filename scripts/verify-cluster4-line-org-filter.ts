/**
 * 검증 + 진단: 4허브 라인 조직(org) 노출 필터.
 *
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-line-org-filter.ts
 *
 * PART A (DB 무관, 순수 로직): 노출 규칙 매트릭스 검증.
 *   - ORG=PHALANX → PX/BS(=phalanx/common)만 노출, EC/OK 차단
 *   - ORG=ENCRE   → EC/BS 만 노출
 *   - ORG=ORANKE  → OK/BS 만 노출
 *   - org 미상 사용자 → 전부 노출(필터 미적용)
 *   - org 불명 라인  → 기본 숨김(fail-closed). 단 Step 1(본인 배정, allowUnknown)만 노출.
 *
 * PART B (DB, read-only): line_code 토큰(우선) ↔ 마스터 organization_slug 불일치 리포트.
 *   노출은 line_code 우선이다. BS 코드가 특정 org 마스터를 덮는 건 의도된 규칙(→ common).
 *   EC/OK/PX 코드가 다른 특정 org 마스터와 충돌하는 경우만 진짜 데이터 이슈(코드가 우선·승리).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  isLineVisibleForUserOrg,
  normalizeLineOrg,
  parseLineCodeOrg,
  type LineOrgScope,
} from "@/lib/cluster4LineOrg";
import type { OrganizationSlug } from "@/lib/organizations";

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "✅" : "❌"} ${label} → ${got} (기대 ${want})`);
}

function partA() {
  console.log("════════ PART A: 노출 규칙 매트릭스 (순수 로직) ════════");
  const lineOrgs: Record<string, LineOrgScope | null> = {
    EC: "encre",
    OK: "oranke",
    PX: "phalanx",
    BS: "common",
    UNKNOWN: null, // 구버전 코드·info 등 판정 불가
  };

  // Step 2(openedByWeek, allowUnknown=false): 판정불가(UNKNOWN) 라인은 숨김.
  const step2Cases: { user: OrganizationSlug | null; visible: string[] }[] = [
    { user: "phalanx", visible: ["PX", "BS"] }, // UNKNOWN 숨김
    { user: "encre", visible: ["EC", "BS"] },
    { user: "oranke", visible: ["OK", "BS"] },
    { user: null, visible: ["EC", "OK", "PX", "BS", "UNKNOWN"] }, // 사용자 org 미상 → 필터 미적용
  ];
  console.log("\n  [Step 2 openedByWeek — 판정불가 숨김(fail-closed)]");
  for (const c of step2Cases) {
    console.log(`\n  사용자 org = ${c.user ?? "(미상)"}`);
    for (const [code, lineOrg] of Object.entries(lineOrgs)) {
      check(
        `라인 ${code}(${lineOrg ?? "불명"})`,
        isLineVisibleForUserOrg(lineOrg, c.user),
        c.visible.includes(code),
      );
    }
  }

  // Step 1(본인 배정, allowUnknown=true): UNKNOWN 도 노출. 단 다른 조직 라인은 여전히 차단.
  const step1Cases: { user: OrganizationSlug | null; visible: string[] }[] = [
    { user: "phalanx", visible: ["PX", "BS", "UNKNOWN"] }, // UNKNOWN 허용
    { user: "encre", visible: ["EC", "BS", "UNKNOWN"] },
    { user: "oranke", visible: ["OK", "BS", "UNKNOWN"] },
    { user: null, visible: ["EC", "OK", "PX", "BS", "UNKNOWN"] },
  ];
  console.log("\n  [Step 1 본인 배정 — 판정불가 허용(allowUnknown)]");
  for (const c of step1Cases) {
    console.log(`\n  사용자 org = ${c.user ?? "(미상)"}`);
    for (const [code, lineOrg] of Object.entries(lineOrgs)) {
      check(
        `라인 ${code}(${lineOrg ?? "불명"})`,
        isLineVisibleForUserOrg(lineOrg, c.user, { allowUnknown: true }),
        c.visible.includes(code),
      );
    }
  }

  console.log("\n  line_code 토큰 파싱 (우선순위 BS>EC>OK>PX, contains):");
  const codeCases: [string, LineOrgScope | null][] = [
    ["EXEC-EN0001", "encre"],
    ["EXOK-EN0001", "oranke"],
    ["EXPX-EN0001", "phalanx"],
    ["EXBS-EL0001", "common"], // BS 포함 → common
    ["CPBS-NN0001", "common"], // BS 포함 → common
    ["WCBS-NL0000", "common"], // career: BS 포함 → master(oranke) 무시하고 common
    ["EX02A - ES0001", null], // 구버전 — 토큰 없음 → 마스터 폴백
    ["wisdom", null], // info(소문자) — 토큰 없음
    ["essay", null], // 소문자 'ok'/'ec' 오탐 없음 검증
    ["", null],
  ];
  for (const [code, want] of codeCases) {
    const got = parseLineCodeOrg(code);
    const ok = got === want;
    if (!ok) failures++;
    console.log(`  ${ok ? "✅" : "❌"} parseLineCodeOrg(${JSON.stringify(code)}) → ${got} (기대 ${want})`);
  }
}

async function partB() {
  console.log("\n════════ PART B: line_code(우선) ↔ 마스터 org 불일치 (DB read-only) ════════");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  ⚠ Supabase 환경변수 없음 → PART B 건너뜀 (PART A 만 실행).");
    return;
  }
  const sb = createClient(url, key);

  const sources: { table: string; orgCol: string }[] = [
    { table: "cluster4_experience_line_masters", orgCol: "organization_slug" },
    { table: "cluster4_competency_line_masters", orgCol: "organization_slug" },
    { table: "career_projects", orgCol: "organization_slug" },
  ];

  let genuine = 0; // EC/OK/PX 코드 vs 다른 특정 org 마스터 → 진짜 데이터 충돌(코드가 우선·승리)
  let bsOverride = 0; // BS 코드가 특정 org 마스터를 덮어 common → 의도된 규칙
  let scanned = 0;
  for (const src of sources) {
    const { data, error } = await sb
      .from(src.table)
      .select(`line_code,${src.orgCol}`);
    if (error) {
      console.log(`  ⚠ ${src.table} 조회 실패: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, string | null>[]) {
      const lineCode = row.line_code;
      if (!lineCode) continue;
      scanned++;
      const masterOrg = normalizeLineOrg(row[src.orgCol]);
      const codeOrg = parseLineCodeOrg(lineCode);
      if (!codeOrg || !masterOrg || codeOrg === masterOrg) continue;
      if (codeOrg === "common") {
        bsOverride++; // BS 코드 → master 무시하고 common. 정책상 정상.
        console.log(
          `  · [BS→common] [${src.table}] code=${JSON.stringify(lineCode)} master=${masterOrg} → 적용=common (전체 노출)`,
        );
      } else {
        genuine++;
        console.log(
          `  ❗ [충돌] [${src.table}] code=${JSON.stringify(lineCode)} codeOrg=${codeOrg} master=${masterOrg} → 적용=${codeOrg}(코드 우선)`,
        );
      }
    }
  }
  console.log(
    `\n  스캔 ${scanned}건 | 코드 vs 마스터 충돌 ${genuine}건 | BS→common 덮어쓰기 ${bsOverride}건.`,
  );
  console.log(
    genuine === 0
      ? "  ✅ 코드 vs 마스터 진짜 충돌 없음 (BS→common 은 의도된 규칙)."
      : "  ⚠ 코드/마스터 충돌 발견 — 노출은 line_code 우선으로 처리됨. 마스터 org 정합 점검 권장.",
  );
}

async function main() {
  partA();
  await partB();
  console.log("\n════════ 결과 ════════");
  if (failures > 0) {
    console.log(`❌ 로직 검증 실패 ${failures}건.`);
    process.exit(1);
  }
  console.log("✅ 로직 검증 전부 통과.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
