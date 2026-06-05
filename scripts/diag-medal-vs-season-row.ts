// medal-week-num(stats-cards successWeeks = period.a) vs 이력서 시즌 줄 기준 일치 확인
import { config } from "dotenv";
config({ path: ".env.local" });
import { getGrowthIndicatorsInternal } from "@/lib/cluster3GrowthData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

async function main() {
  for (const id of process.argv.slice(2)) {
    const [g, dto] = await Promise.all([
      getGrowthIndicatorsInternal(id),
      getCluster1Resume(id),
    ]);
    const springRow = (dto?.seasonRecords ?? []).find(
      (r: any) => r.year === "26" && r.seasonName.includes("봄"),
    );
    const totalSeasonApproved = (dto?.seasonRecords ?? []).reduce(
      (n: number, r: any) => n + (r.approvedWeeks ?? 0),
      0,
    );
    console.log(
      `${id.slice(0, 8)} | medal(period.a)=${g.period.a} | 26봄 줄=${springRow?.approvedWeeks}/${springRow?.totalWeeks} | 시즌줄 합=${totalSeasonApproved} | 일치=${g.period.a === totalSeasonApproved ? "✓" : "✗"}`,
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
