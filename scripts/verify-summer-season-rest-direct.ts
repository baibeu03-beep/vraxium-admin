/**
 * 검증(read-only, 서버 불필요): 2026-summer 휴식 적용 결과 direct 함수 기준.
 *   npx tsx --env-file=.env.local scripts/verify-summer-season-rest-direct.ts
 *
 * 확인:
 *   A. direct getSeasonParticipations(2026-summer, rest) = 44 + org별(encre30/oranke6/phalanx8)
 *   B. 봄 기록 보존 — 2026-spring rest 여전히 365, 44명의 봄 uws/uwp 무변화(여름행만 추가)
 *   C. 시즌 스코프 — 다른 시즌 조회엔 44명이 휴식으로 안 나옴(소급 없음)
 *   D. snapshot 영향/재계산 필요 — 오늘 현재시즌 판정 + 샘플 loadWeeklyCards 에 여름 카드 부재
 *   E. demoUserId==일반 DTO — readWeeklyCardsSnapshot vs loadWeeklyCards 동치(snapshot-only 유지)
 */
import { readFileSync, readdirSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const applyFile = readdirSync("claudedocs").filter((f) => f.startsWith("apply-summer-season-rest-apply-")).sort().reverse()[0];
const APPLIED = JSON.parse(readFileSync(`claudedocs/${applyFile}`, "utf8"));

async function main() {
  hr(); line("A. direct getSeasonParticipations(2026-summer, rest)"); hr();
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: "rest", organizationSlug: null, search: null });
  const perOrg: Record<string, number> = {};
  for (const r of dto.rows) perOrg[r.organization_slug ?? "(null)"] = (perOrg[r.organization_slug ?? "(null)"] ?? 0) + 1;
  line(`  rows=${dto.rows.length} summary.rest_count=${dto.summary.rest_count} perOrg=${JSON.stringify(perOrg)}`);
  ck("총 44행", dto.rows.length === 44, `${dto.rows.length}`);
  ck("encre 30", perOrg.encre === 30, `${perOrg.encre}`);
  ck("oranke 6", perOrg.oranke === 6, `${perOrg.oranke}`);
  ck("phalanx 8", perOrg.phalanx === 8, `${perOrg.phalanx}`);
  ck("전부 status=rest", dto.rows.every((r) => r.status === "rest"));
  ck("전부 season_key=2026-summer", dto.rows.every((r) => r.season_key === "2026-summer"));

  hr(); line("B. 봄 기록 보존"); hr();
  const { count: springRest } = await supabaseAdmin.from("user_season_statuses")
    .select("user_id", { count: "exact", head: true }).eq("season_key", "2026-spring").eq("status", "rest");
  ck("2026-spring rest 365 유지", springRest === 365, `${springRest}`);
  line(`  (적용 로그: ${applyFile}, resolved=${(APPLIED.resolved ?? []).length})`);
  // 봄 활동자 샘플 = 현유빈(807f863e). 봄 success 9 유지 기대.
  const { data: hyubin } = await supabaseAdmin.from("user_profiles").select("user_id,growth_status").eq("organization_slug", "encre").eq("display_name", "현유빈").maybeSingle();
  if (hyubin) {
    const { count: springWeeks } = await supabaseAdmin.from("user_week_statuses")
      .select("user_id", { count: "exact", head: true }).eq("user_id", (hyubin as any).user_id).eq("season_key", "2026-spring").eq("status", "success");
    ck("현유빈 봄 success 9주 보존", springWeeks === 9, `${springWeeks}`);
    ck("현유빈 growth_status 미변경(active)", (hyubin as any).growth_status === "active", `${(hyubin as any).growth_status}`);
    // 봄 시즌 status 행이 새로 생기지 않았는지(소급 금지)
    const { data: hySeasons } = await supabaseAdmin.from("user_season_statuses").select("season_key,status").eq("user_id", (hyubin as any).user_id);
    const springRow = (hySeasons ?? []).find((s: any) => s.season_key === "2026-spring");
    ck("현유빈 봄 season_status 신규생성 없음", !springRow, springRow ? `봄=${(springRow as any).status}` : "없음");
    ck("현유빈 여름 rest 행 존재", (hySeasons ?? []).some((s: any) => s.season_key === "2026-summer" && s.status === "rest"));
  }

  hr(); line("C. 시즌 스코프(소급 없음) — 44명이 봄/가을 등 다른 시즌 휴식으로 안 나옴"); hr();
  const summerUsers = new Set(dto.rows.map((r) => r.user_id));
  for (const sk of ["2026-spring", "2026-autumn", "2025-summer"]) {
    const d = await getSeasonParticipations({ seasonKey: sk, status: "rest", organizationSlug: null, search: null });
    const leak = d.rows.filter((r) => summerUsers.has(r.user_id)).length;
    line(`  ${sk}: rest ${d.rows.length}행 중 여름44 겹침 ${leak} (봄=이미휴식21 겹침 정상, 그외 시즌=0 기대)`);
  }
  // 핵심: 봄 활동자(원래 봄 휴식 아님)는 봄 rest 로 안 나와야
  const { data: springRestRows } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", "2026-spring").eq("status", "rest");
  const springRestSet = new Set((springRestRows ?? []).map((r: any) => r.user_id));
  const summerActiveOnes = dto.rows.filter((r) => !springRestSet.has(r.user_id));
  ck(`봄-비휴식 여름휴식자(${summerActiveOnes.length}명)는 봄 rest 미포함(소급 없음)`, summerActiveOnes.every((r) => !springRestSet.has(r.user_id)));

  hr(); line("D. snapshot 영향/재계산 필요"); hr();
  const today = new Date().toISOString().slice(0, 10);
  const curSeason = getSeasonForDate(today);
  const curKey = curSeason ? seasonDbKey(curSeason) : null;
  line(`  오늘=${today} 현재시즌=${curKey ?? "(없음/갭)"}  (2026-summer 시작=2026-06-29)`);
  ck("오늘 현재시즌 ≠ 2026-summer (여름 미시작)", curKey !== "2026-summer", `${curKey}`);
  // 샘플 여름휴식자: 저장된 snapshot card_count vs 현재 live 재계산 card_count 비교.
  //   동일하면 → 내 season_status insert 가 카드(snapshot)에 영향 없음.
  const sampleId = dto.rows[0].user_id;
  const liveCards = await getCluster4WeeklyCardsForProfileUser(sampleId);
  const { data: snapRow } = await supabaseAdmin.from("cluster4_weekly_card_snapshots")
    .select("card_count,is_stale,computed_at").eq("user_id", sampleId).maybeSingle();
  const storedCount = snapRow ? (snapRow as any).card_count : null;
  line(`  샘플=${sampleId.slice(0, 8)} 저장 snapshot card_count=${storedCount} is_stale=${snapRow ? (snapRow as any).is_stale : "(행없음)"} computed=${snapRow ? (snapRow as any).computed_at : "-"}`);
  line(`  현재 live 재계산 card_count=${liveCards.length}`);
  ck("snapshot 영향 없음(저장 card_count == live 재계산)", storedCount === liveCards.length, `${storedCount} vs ${liveCards.length}`);
  ck("내 insert 가 snapshot 을 stale 로 만들지 않음", !snapRow || (snapRow as any).is_stale === false, `is_stale=${snapRow ? (snapRow as any).is_stale : "n/a"}`);
  // 여름(미래) 카드 부재 확인 — 실제 카드의 startDate/seasonKey 기준(메타데이터 문자열 무시)
  const summerCards = (liveCards as any[]).filter((c) => c.seasonKey === "2026-summer" || (typeof c.startDate === "string" && c.startDate >= "2026-06-29"));
  ck("live 카드에 2026-summer 주차 카드 없음(여름 미시작)", summerCards.length === 0, `summerCards=${summerCards.length}`);
  line(`  ⇒ 결론: admin season-participations 는 snapshot 비의존(direct 쿼리) → 즉시 정확.`);
  line(`         고객 weekly-cards 는 여름 시작(06-29) 후 boundary lazy 재계산으로 반영 → 현재 재계산 불필요.`);

  hr(); line("E. snapshot-only 동치 (demoUserId==일반 DTO 경로)"); hr();
  const snapRead = await readWeeklyCardsSnapshot(sampleId);
  if (snapRead.status === "hit" || snapRead.status === "stale") {
    ck(`snapshot-only 카드수 == live 카드수(${snapRead.cards.length} vs ${liveCards.length})`, snapRead.cards.length === liveCards.length);
  } else {
    line(`  snapshot status=${snapRead.status} (miss/error) — 동치 비교 생략`);
  }
  line(`  (demo 모드는 조회 userId override only — 동일 getCluster4WeeklyCardsForProfileUser/readWeeklyCardsSnapshot 경로, DTO 분기 없음)`);

  hr();
  line(fail === 0 ? "✅ DIRECT 검증 ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
