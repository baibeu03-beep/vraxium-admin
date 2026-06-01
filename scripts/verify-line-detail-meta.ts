/**
 * [READ-ONLY] career 라인 편집 모달 source(listCluster4LinesDetailed)에
 * sponsor-card 6필드가 실제로 내려오는지 실데이터로 검증.
 *   npx tsx --env-file=.env.local scripts/verify-line-detail-meta.ts
 */
import { listCluster4LinesDetailed } from "@/lib/adminCluster4LinesData";

async function main() {
  const { rows } = await listCluster4LinesDetailed({ partType: "career", limit: 50 });
  console.log(`career detailed 라인 ${rows.length}건\n`);
  for (const r of rows) {
    console.log(
      JSON.stringify(
        {
          id: r.id,
          lineCode: r.lineCode,
          weekLabel: r.weekLabel,
          mainTitle: r.mainTitle?.slice(0, 20),
          careerProjectId: r.careerProjectId,
          companyName: r.companyName,
          companyLogoUrl: r.companyLogoUrl,
          supervisorName: r.supervisorName,
          supervisorDepartment: r.supervisorDepartment,
          supervisorPosition: r.supervisorPosition,
          supervisorPhotoUrl: r.supervisorPhotoUrl,
        },
        null,
        2,
      ),
    );
    const six = [
      "companyName",
      "companyLogoUrl",
      "supervisorName",
      "supervisorDepartment",
      "supervisorPosition",
      "supervisorPhotoUrl",
    ];
    const present = six.filter((k) => k in r);
    console.log(`→ 6필드 키 존재: ${present.length}/6\n`);
  }
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
