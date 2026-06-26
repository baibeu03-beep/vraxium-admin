// 검증: 레거시 info override 제거(working tree)가 실제 DTO 에 미치는 효과 +
//   direct 함수 결과 == HTTP(internal-key) 응답 일치 + HEAD(override 포함) 대비 flip 시연.
import { config } from "dotenv";
config({ path: ".env.local" });
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";

const KEY = process.env.INTERNAL_API_KEY!;
const BASE = "http://localhost:3000";

// 검증 대상: diag 가 뽑은 실사용자 표본
const USERS = [
  "50610737-9d35-4514-a617-c70072d4b2c0",
  "80223a7e-d5d9-40e1-8a7f-f552e6fbbcf3",
  "d9503c5b-6c4e-46ed-acce-31a5b6d01a0c",
  "535fd54a-b9c4-4daa-a364-b4360d87a90f",
];

function infoCells(cards: any[]) {
  const out: any[] = [];
  for (const c of cards ?? []) {
    for (const ln of c.lines ?? []) {
      const part = ln.partType ?? ln.part_type;
      if (part !== "information") continue;
      out.push({
        week: c.weekId ?? c.weekLabel,
        enh: ln.enhancementStatus,
        sub: ln.submissionStatus,
        reason: ln.enhancementReason,
        status: ln.status,
      });
    }
  }
  return out;
}

// HEAD(override 포함) 가 같은 칸에 내렸을 enhancementStatus 재현:
//   legacy info 칸은 base.status(submission-based) 로 덮였다 → computeLineStatus 와 동일.
//   여기선 working-tree DTO 의 submissionStatus/status 로 역산: 마감 후 미제출이면 HEAD=fail.
function headOverrideEnh(cell: any): string {
  if (cell.sub === "submitted") return "success";
  // 미제출: status 가 fail(마감 후)이면 HEAD override = fail, 아니면 pending
  return cell.status === "fail" ? "fail" : cell.enh;
}

async function http(userId: string) {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  return Array.isArray(j.data) ? j.data : (j.cards ?? j.data?.cards ?? []);
}

async function main() {
  for (const u of USERS) {
    console.log(`\n========== ${u} ==========`);
    const directCards = await getCluster4WeeklyCardsForProfileUser(u);
    const directInfo = infoCells(directCards);
    let httpInfo: any[] = [];
    let httpErr = "";
    try {
      httpInfo = infoCells(await http(u));
    } catch (e) {
      httpErr = e instanceof Error ? e.message : String(e);
    }

    const dKey = JSON.stringify(directInfo.map((c) => [c.week, c.enh, c.sub]).sort());
    const hKey = JSON.stringify(httpInfo.map((c) => [c.week, c.enh, c.sub]).sort());
    console.log(`info 칸: direct ${directInfo.length} / http ${httpInfo.length} | direct==http: ${httpErr ? "HTTP ERR: " + httpErr : dKey === hKey}`);

    for (const c of directInfo) {
      const head = headOverrideEnh(c);
      const flip = head !== c.enh ? `  ⚠ HEAD(override)=${head} → working-tree=${c.enh}` : "";
      console.log(`   ${c.week} | enh=${c.enh} sub=${c.sub} status=${c.status} reason=${c.reason}${flip}`);
    }
  }

  // computeCluster4Enhancement 순수 시연: 타깃+마감후+미제출, info 경로(verdict 미전달)
  console.log(`\n--- 순수 함수 시연 (info: 타깃+마감후+미제출) ---`);
  const common = computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false });
  console.log(`   공용규칙(working-tree info) = ${common.enhancementStatus} (${common.enhancementReason})`);
  console.log(`   HEAD override(info=submission-based) = fail (computeLineStatus: 마감후 미제출)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
