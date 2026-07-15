/**
 * READ-ONLY: resolveRecognitionInputs + listLinePointConfigs 가 실제 스키마에서 무오류로 도는지 확인.
 *   (UPDATE/computeAndPersist 는 호출하지 않음 — 순수 조회만.) 마이그 전 graceful degradation 검증.
 *   npx tsx --env-file=.env.local scripts/inspect-recognition-resolver.ts
 */
import { resolveRecognitionInputs } from "@/lib/weekRecognitionResolve";
import { listLinePointConfigs } from "@/lib/adminLinePointConfigsData";
import { computeWeekRecognitionCount } from "@/lib/weekRecognitionCount";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";

async function main() {
  const { rows } = await loadSeasonWeeks();
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];

  // 최소 합성 config(일부 open) — 조회 경로 전부 밟게 한다.
  const config = {
    practicalInfo: { wisdom: true, essay: true },
    practicalExperience: { "team-x": { derive: true, analysis: true } },
    practicalCompetency: { checked: true },
    actCheck: { info: {}, club: {}, experience: { "team-x": {} } },
  };

  const { acts, lines, pointConfigAvailable } = await resolveRecognitionInputs({
    weekId: week.week_id,
    organization: "phalanx",
    config,
    openConfirmed: true,
  });
  const result = computeWeekRecognitionCount({ acts, lines });
  console.log("✅ resolveRecognitionInputs OK (무오류)");
  console.log(`  pointConfigAvailable=${pointConfigAvailable} (마이그 전 false 정상)`);
  console.log(`  acts=${acts.length} · lines=${lines.length} · open acts=${acts.filter((a) => a.isOpen).length} · open lines=${lines.filter((l) => l.isOpen).length}`);
  console.log(`  A=${result.minimalA} B=${result.diligentB} N=${result.recognitionCountN} (config 미적용이라 포인트 0 → N=0 정상)`);

  const list = await listLinePointConfigs("phalanx");
  console.log(`✅ listLinePointConfigs OK · available=${list.available} · rows=${list.rows.length}`);
  const byHub: Record<string, number> = {};
  for (const r of list.rows) byHub[r.hub] = (byHub[r.hub] ?? 0) + 1;
  console.log("  허브별 available config key:", byHub);
}
main().catch((e) => { console.error("❌", e); process.exit(1); });
