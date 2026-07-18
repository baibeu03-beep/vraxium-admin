// crewClassPositionCode 생성 검증 (읽기 전용 — 스냅샷 미기록).
//   실제 카드 빌더(getCluster4WeeklyCardsForProfileUser)를 호출해 주차별
//   roleLabel(등급) vs crewClassPositionCode(직책) + 라벨 변환 결과를 출력한다.
// 사용: npx tsx --env-file=.env.local scripts/verify-crew-class-position-code.ts
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { positionCodeToClassLabel } from "@/shared/crewClassPosition";

const USERS: Array<{ id: string; name: string; expect: string }> = [
  { id: "e318c666-b5f4-4508-916b-a228995baf15", name: "전성은(team_leader, 일반등급)", expect: "2025=정규 / 2026=운영진(팀장)" },
  { id: "16000b1f-30ad-4187-9754-11199a577a09", name: "유재희(team_leader, 심화등급)", expect: "과거=이력값 / native=운영진(팀장)" },
  { id: "40b2e0a5-016e-4559-8508-3861deb81065", name: "추가현(crew, 일반등급)", expect: "정규" },
];

async function main() {
  for (const u of USERS) {
    console.log(`\n==== ${u.name}  기대: ${u.expect} ====`);
    const cards = await getCluster4WeeklyCardsForProfileUser(u.id);
    const bySeason = new Map<string, { code: string | null; label: string | null; roleLabel: string | null; n: number }>();
    for (const c of cards) {
      const anyC = c as unknown as { seasonKey?: string | null; roleLabel?: string | null; crewClassPositionCode?: string | null };
      const season = anyC.seasonKey ?? "(no-season)";
      const code = anyC.crewClassPositionCode ?? null;
      const key = `${season} | code=${code} | class=${positionCodeToClassLabel(code as never)} | roleLabel=${anyC.roleLabel}`;
      const prev = bySeason.get(key);
      if (prev) prev.n++;
      else bySeason.set(key, { code, label: positionCodeToClassLabel(code as never), roleLabel: anyC.roleLabel ?? null, n: 1 });
    }
    for (const [key, v] of bySeason) console.log(`  [x${v.n}] ${key}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
