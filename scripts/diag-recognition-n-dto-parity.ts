// Read-only diagnostic: "주차 인정 기준 (N)" 탭 DTO 값이 실제 verdict 가 읽는 값과 동일한지 확인.
//   getWeekRecognitions() 가 반환하는 weekOption.recognition_n_by_org 와,
//   verdict/finalize 가 직접 호출하는 fetchWeekRecognitionRequiredByOrg 결과를 조직별로 대조한다.
//   어떤 write 도 하지 않는다.
//
//   run: node_modules/.bin/tsx scripts/diag-recognition-n-dto-parity.ts
import "dotenv/config";
import { getWeekRecognitions } from "@/lib/adminWeekRecognitionsData";
import { fetchWeekRecognitionRequiredByOrg } from "@/lib/lineAvailability";
import { ORGANIZATIONS } from "@/lib/organizations";

async function main() {
  const dto = await getWeekRecognitions({});
  const weeks = dto.weeks;
  console.log(`weeks in DTO: ${weeks.length}`);

  let checked = 0;
  let mismatches = 0;
  let withAnyN = 0;

  // 조직별 verdict 함수 직접 조회(= 판정이 읽는 원천).
  const weekIds = weeks.map((w) => w.week_id);
  const verdictByOrg: Record<string, Map<string, number | null>> = {};
  for (const org of ORGANIZATIONS) {
    verdictByOrg[org] = await fetchWeekRecognitionRequiredByOrg(weekIds, org);
  }

  for (const w of weeks) {
    for (const org of ORGANIZATIONS) {
      const dtoVal = w.recognition_n_by_org[org];
      const verdictVal = verdictByOrg[org].get(w.week_id) ?? null;
      checked++;
      if (dtoVal !== verdictVal) {
        mismatches++;
        console.error(
          `MISMATCH week=${w.week_label}(${w.week_id}) org=${org} dto=${dtoVal} verdict=${verdictVal}`,
        );
      }
      if (dtoVal != null) withAnyN++;
    }
  }

  // 실제 N 이 설정된 몇 개 주차 샘플 출력(사람 확인용).
  const samples = weeks.filter((w) => w.recognition_missing_org_count < ORGANIZATIONS.length).slice(0, 8);
  console.log("\n샘플(설정된 조직 N 존재 주차):");
  for (const w of samples) {
    const cells = ORGANIZATIONS.map(
      (org) => `${org}=${w.recognition_n_by_org[org] ?? "미설정"}`,
    ).join("  ");
    console.log(
      `  ${w.season_key ?? "-"} ${w.week_label}: ${cells}  | 미설정 ${w.recognition_missing_org_count}/${ORGANIZATIONS.length} allSet=${w.recognition_all_orgs_set}`,
    );
  }

  console.log(
    `\nchecked cells=${checked}  mismatches=${mismatches}  nonNullDtoCells=${withAnyN}`,
  );
  console.log(mismatches === 0 ? "PARITY OK (DTO == verdict source)" : "PARITY FAILED");
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
