/**
 * 어드민 전역 데이터 정합성 — fast 계층 오케스트레이터.
 *   DB 직결(dev 서버·브라우저 불필요) 검증만 모아 한 번에 돌린다. 화면을 하나씩 눌러보지 않고도
 *   "팀/파트/클래스", "졸업/바사노스/휴식/중단 축", "운용 파트", "org/mode 스코프" 정합성을
 *   한 명령으로 확인하기 위한 진입점이다.
 *
 *   여기 묶인 스크립트는 전부 기존에 개별적으로 존재하던 검증(각자 npm run verify:* 별칭 보유) —
 *   이 오케스트레이터는 새 판정 로직을 만들지 않고, **이미 있는 SoT 검증들을 한 곳에서 순서대로
 *   실행하고 결과를 취합**한다. 실패해도 나머지를 계속 돌려 전체 그림을 한 번에 보여준다
 *   (`&&` 체인과 달리 첫 실패에서 멈추지 않음).
 *
 *   full 계층(브라우저·dev 서버·크루 앱(front :3001) 필요한 검증)은 아직 이 오케스트레이터에
 *   묶지 않았다 — 개별 npm run verify:week-position-* / verify:position-resolver-dom 등을
 *   직접 실행할 것. 향후 verify:admin-consistency:full 로 별도 묶을 예정(README 참고).
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-admin-consistency-fast.ts
 *   (== npm run verify:admin-consistency:fast)
 */
import { spawnSync } from "node:child_process";

type Check = {
  label: string;
  npmScript: string; // package.json 의 verify:* 별칭 — 원본 검증을 그대로 재사용(로직 복붙 금지).
  domain: string;
};

// ── fast 계층 구성 — DB 직결(--env-file=.env.local)만, dev 서버/브라우저 불필요 ──
const CHECKS: Check[] = [
  {
    domain: "팀/파트/클래스(positionResolver SoT)",
    label: "팀장 승격/복귀 시 team/part 가 user_memberships(SoT) 로 정확히 반영되는지",
    npmScript: "verify:team-leader-position-sync",
  },
  {
    domain: "운용 파트(loadTeamWeekRostersBulk SoT)",
    label: "매트릭스/[A]/파트 칩/operating·test 4경로 일치",
    npmScript: "verify:operated-part-sot",
  },
  {
    domain: "클래스 라벨(resolvePositionLabels SoT)",
    label: "클래스 라벨 어휘 일관성",
    npmScript: "verify:crew-class-label",
  },
  {
    domain: "졸업(엘리트) 제외 — 현재 활동 모집단",
    label: "전 조직·전 활성 팀·operating/test — 실무 정보 개설 대상·긴급 휴식 대상에서 졸업 크루 0명",
    npmScript: "verify:admin-graduated-population-global",
  },
  {
    domain: "졸업(엘리트) 제외 — 팀·파트 배정 crewRows",
    label: "전 조직·전 활성 팀·현재 주차 — team-parts crewRows 에서 졸업 크루 0명",
    npmScript: "verify:team-parts-graduated-global-exclusion",
  },
  {
    domain: "org/mode 스코프 중앙화",
    label: "resolveUserScope/resolveRequestScope 헬퍼 사용 여부(직접 스코프 재구현 없음)",
    npmScript: "verify:scope-helper-usage",
  },
  {
    domain: "org/mode 스코프 중앙화",
    label: "스코프 중앙화 1단계 회귀",
    npmScript: "verify:scope-centralization",
  },
];

type Result = Check & { ok: boolean; ms: number; tail: string };

function run(check: Check): Result {
  const started = Date.now();
  const proc = spawnSync("npm", ["run", "--silent", check.npmScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: true,
  });
  const ms = Date.now() - started;
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  const tailLines = output.trim().split("\n").slice(-6).join("\n");
  return { ...check, ok: proc.status === 0, ms, tail: tailLines };
}

function main() {
  console.log(`=== 어드민 정합성 fast 검증 — ${CHECKS.length}종 ===\n`);
  const results: Result[] = [];
  for (const check of CHECKS) {
    process.stdout.write(`▶ [${check.domain}] ${check.label} (npm run ${check.npmScript}) ... `);
    const r = run(check);
    results.push(r);
    console.log(`${r.ok ? "✓ PASS" : "✗ FAIL"} (${(r.ms / 1000).toFixed(1)}s)`);
    if (!r.ok) {
      console.log("  ── 마지막 출력 ──");
      console.log(
        r.tail
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n"),
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) {
    console.log("실패한 검증:");
    for (const f of failed) console.log(`  ✗ [${f.domain}] ${f.label} — npm run ${f.npmScript}`);
    process.exit(1);
  }
}

main();
