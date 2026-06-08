// 조사 전용(직접 함수 실행): getGrowthIndicatorsInternal — stats-cards SoT 함수.
// 사용: npx tsx --env-file=.env.local scripts/diag_direct_growth_indicators.ts
// 출력: scripts/diag_direct_growth_indicators.out.json (PS 한글 캡처 회피 — 파일로 기록)
import fs from "node:fs";
import { getGrowthIndicatorsInternal } from "@/lib/cluster3GrowthData";
import { getCluster3StatsCards } from "@/lib/cluster3StatsCardsData";

const USERS = [
  { label: "T황하린(oranke,19w)", id: "8e38d52f-727e-429b-9db3-423cd031d2a5" },
  { label: "T조민재(encre,19w)", id: "ec11fe34-0cba-4bbc-afae-6d7514fdf57e" },
];

async function main() {
  const out: Record<string, unknown> = {};
  for (const u of USERS) {
    const internal = await getGrowthIndicatorsInternal(u.id);
    const dto = await getCluster3StatsCards(u.id);
    out[u.label] = {
      process: internal.process,
      period: internal.period,
      _debug: internal._debug,
      statsCardsProcessDto: dto.process,
    };
  }
  fs.writeFileSync(
    new URL("./diag_direct_growth_indicators.out.json", import.meta.url),
    JSON.stringify(out, null, 2),
  );
  console.log("OK -> scripts/diag_direct_growth_indicators.out.json");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
