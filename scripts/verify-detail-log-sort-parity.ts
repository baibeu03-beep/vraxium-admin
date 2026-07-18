/**
 * shared/detailLogSort.ts 미러 파리티 — vraxium-admin == vraxium (byte-identical).
 *   npx tsx scripts/verify-detail-log-sort-parity.ts
 *
 * 정렬 계약은 두 앱(어드민 주차 상세 · 크루 Detail Log)이 공유하므로 한쪽만 고치면 정렬이 갈라진다.
 * 이 스크립트는 두 레포의 파일이 **바이트 단위로 동일**한지 확인한다(crewActSummary/crewClassPosition 규약).
 *   크루 레포 위치: 기본 ../vraxium (환경변수 CREW_REPO 로 override).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ADMIN_FILE = resolve(process.cwd(), "shared/detailLogSort.ts");
const CREW_ROOT = process.env.CREW_REPO ?? resolve(process.cwd(), "..", "vraxium");
const CREW_FILE = resolve(CREW_ROOT, "shared/detailLogSort.ts");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${!ok && detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

check(`어드민 파일 존재: ${ADMIN_FILE}`, existsSync(ADMIN_FILE));
check(`크루 파일 존재: ${CREW_FILE}`, existsSync(CREW_FILE), { hint: "CREW_REPO 환경변수로 경로 지정" });

if (existsSync(ADMIN_FILE) && existsSync(CREW_FILE)) {
  const a = readFileSync(ADMIN_FILE);
  const b = readFileSync(CREW_FILE);
  check("두 shared/detailLogSort.ts 가 byte-identical", a.equals(b), {
    adminBytes: a.length,
    crewBytes: b.length,
  });
}

console.log(failed > 0 ? `\n═══ FAIL ${failed} — 미러가 갈라졌습니다. 양쪽을 동일하게 맞추세요.` : "\n═══ PASS — 미러 동일.");
process.exit(failed > 0 ? 1 : 0);
