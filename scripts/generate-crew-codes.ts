// ===================================================================
// 크루 코드 (재)생성 — 확정 공식. 운영 식별자(고정). snapshot/포인트 무접촉.
//   공식: (년생)(성별)(이름순)-(클럽)(YY 시즌 WW)(지원성적)   예) 036011-1263022
//
// 선행: db/migrations/2026-06-17_crew_code_and_management_notes.sql 적용(SQL Editor).
//
// 실행:
//   DRY-RUN(미변경 미리보기): npx tsx --env-file=.env.local scripts/generate-crew-codes.ts
//   결번만 채움(freeze)       : npx tsx --env-file=.env.local scripts/generate-crew-codes.ts --apply
//   공식 전환(전체 재생성)    : npx tsx --env-file=.env.local scripts/generate-crew-codes.ts --apply --force
//   조직 한정                 : ... --org=encre   (encre|oranke|phalanx)
//   모집단                    : ... --mode=test   (기본 operating)
//
// --force 는 기존 코드를 새 공식으로 교체하며 old→new 를 crew_code_log 에 적재(백업).
// --apply 없으면 write 0(계획만). 중복 발생 시 write 중단(예외).
// ===================================================================
import { generateCrewCodes } from "@/lib/adminCrewCodeData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const orgRaw = argValue("--org");
  const mode = parseScopeMode(argValue("--mode"));

  let organization: OrganizationSlug | null = null;
  if (orgRaw) {
    if (!isOrganizationSlug(orgRaw)) {
      console.error(`Unknown --org: ${orgRaw} (encre|oranke|phalanx)`);
      process.exit(1);
    }
    organization = orgRaw;
  }

  console.log(
    `[generate-crew-codes] mode=${mode} org=${organization ?? "ALL"} force=${force} ${apply ? "APPLY" : "DRY-RUN"}`,
  );

  const result = await generateCrewCodes({
    organization,
    mode,
    force,
    dryRun: !apply,
  });

  console.log("─".repeat(60));
  console.log(`total            : ${result.total}`);
  console.log(`create(신규)     : ${result.created}`);
  console.log(`replace(교체)    : ${result.replaced}`);
  console.log(`unchanged(동일)  : ${result.unchanged}`);
  console.log(`frozen(force off): ${result.skippedFrozen}`);
  console.log(`unresolved(미생성): ${result.unresolved}`);
  console.log(`duplicateCodes   : ${result.duplicateCodes.length}`);
  console.log(`dryRun           : ${result.dryRun}`);
  console.log("─".repeat(60));

  // 변경 대상 샘플(최대 20).
  const changes = result.planned.filter(
    (p) => (p.reason === "create" || p.reason === "replace") && p.newCode,
  );
  console.log(`변경 대상 ${changes.length}건 (샘플 20):`);
  for (const c of changes.slice(0, 20)) {
    console.log(
      `  ${c.displayName.padEnd(8)} ${c.startWeekKey ?? "-"}  ${c.oldCode ?? "∅"} → ${c.newCode}  (#${c.nameOrder}, g${c.grade}, ${c.reason})`,
    );
  }

  // 미생성 사유 집계.
  if (result.unresolved > 0) {
    const reasons = new Map<string, number>();
    for (const p of result.planned) {
      if (p.newCode == null) reasons.set(p.reason ?? "?", (reasons.get(p.reason ?? "?") ?? 0) + 1);
    }
    console.log("미생성 사유:");
    for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${r}: ${n}`);
    }
  }

  if (result.duplicateCodes.length > 0) {
    console.error("⚠ 중복 코드:", result.duplicateCodes.slice(0, 10));
    process.exit(2);
  }

  console.log(apply ? "✅ APPLIED" : "ℹ DRY-RUN (no writes). --apply 로 반영.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
