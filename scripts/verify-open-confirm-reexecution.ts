/*
 * verify-open-confirm-reexecution.ts
 *
 * [오픈 확인] 재실행 정책(시점 경계 타임라인)의 핵심 순수 로직을 결정론적으로 검증한다.
 *   - 마이그레이션(cluster4_week_opening_config_versions)은 수동 적용이라, DB 통합 테스트는
 *     테이블 존재 시에만 수행하고(현재는 스킵), 시점 경계 판정 자체는 순수 함수로 100% 검증한다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-open-confirm-reexecution.ts
 *   (DB 프로브만 env 필요 — 순수 테스트는 env 없이도 통과)
 */

import {
  resolveConfigAtTime,
  isActOpenAtTime,
  type ActOpenTimeline,
  type TimelineVersion,
} from "@/lib/weekOpenGate";
import { resolveRegularActOccurredAtMs } from "@/lib/regularActRequiredAt";
import { weekThursdayBoundaryMs } from "@/lib/seasonCalendar";
import {
  resolveReopenEligibility,
  REOPEN_BLOCKED_PUBLISHED,
  REOPEN_BLOCKED_PAST_THURSDAY,
} from "@/lib/weekReopenPolicy";
import type { SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`, extra !== undefined ? extra : "");
  }
}

// ── 픽스처: 관리 주차 월요일 = 2026-06-01(월). occur 시각 = 주 시작 + occur_dow + occur_time(KST). ──
const WEEK_START = "2026-06-01"; // 월요일
// occur_dow: 0=일 … 6=토. 수요일 = 3. (adminTeamPartsInfoActCheckData DOW 키 맵과 동일 규약)
const WED = 3;
const wisdomLg = "lg-wisdom";
const essayLg = "lg-essay";

// info 허브 액트 2개(위즈덤/에세이) × 수요일 10:00 / 19:00.
const occ = (dow: number, time: string, week: string | null = "N"): number => {
  const ms = resolveRegularActOccurredAtMs({ weekStart: WEEK_START, occurWeek: week, occurDow: dow, occurTime: time });
  if (ms == null) throw new Error("occurMs null");
  return ms;
};
const wisdom10 = occ(WED, "10:00");
const wisdom19 = occ(WED, "19:00");
const essay10 = occ(WED, "10:00");
const essay19 = occ(WED, "19:00");

// v1(최초 확인, 화요일 확정): 위즈덤 on, 에세이 off.
const cfgV1: SavedConfig = { actCheck: { info: { [wisdomLg]: true, [essayLg]: false } } };
// v2(재실행, 수 15:00 확정): 위즈덤 off, 에세이 on.
const cfgV2: SavedConfig = { actCheck: { info: { [wisdomLg]: false, [essayLg]: true } } };

const t1 = occ(2, "00:00"); // 화요일 00:00 (v1 effective_from)
const tChange = occ(WED, "15:00"); // 수 15:00 (v2 effective_from = 재실행 확정 시각)

const versionsAfterReexec: TimelineVersion[] = [
  { config: cfgV1, effectiveFromMs: t1 },
  { config: cfgV2, effectiveFromMs: tChange },
];
const timelineAfterReexec: ActOpenTimeline = {
  openConfirmed: true,
  latestConfig: cfgV2,
  versions: versionsAfterReexec,
  timelineAvailable: true,
};
const timelineFirstOnly: ActOpenTimeline = {
  openConfirmed: true,
  latestConfig: cfgV1,
  versions: [{ config: cfgV1, effectiveFromMs: t1 }],
  timelineAvailable: true,
};

const isOpen = (tl: ActOpenTimeline, lg: string, occurMs: number): boolean =>
  isActOpenAtTime({ hub: "info", timeline: tl, occurMs, lineGroupId: lg });

console.log("── occur 시각 산출(요일수학·N1 오프셋) ──");
{
  // 수요일 10:00 = 월(06-01) + 2일 = 06-03 10:00 KST.
  const expected = Date.parse("2026-06-03T10:00:00+09:00");
  check("수요일 10:00 occur ms", wisdom10 === expected, { wisdom10, expected });
  check("19:00 > 10:00", wisdom19 > wisdom10);
  // N1(다음 주) 오프셋 = +7일.
  const nextWed10 = occ(WED, "10:00", "N1");
  check("N1 수요일 = +7일", nextWed10 - wisdom10 === 7 * 24 * 60 * 60 * 1000, { diff: nextWed10 - wisdom10 });
  // occur_time 없으면 그 날 00:00 KST.
  const noTime = resolveRegularActOccurredAtMs({ weekStart: WEEK_START, occurWeek: "N", occurDow: WED, occurTime: null });
  check("occur_time 없음 = 00:00 KST", noTime === Date.parse("2026-06-03T00:00:00+09:00"), { noTime });
  // weekStart 없으면 null(폴백 신호).
  check("weekStart 없음 = null", resolveRegularActOccurredAtMs({ weekStart: null, occurWeek: "N", occurDow: WED, occurTime: "10:00" }) === null);
}

console.log("── 시나리오 A: 최초 확인(v1만) — 위즈덤 가동·에세이 미가동 ──");
{
  check("A 위즈덤@10 가동", isOpen(timelineFirstOnly, wisdomLg, wisdom10) === true);
  check("A 위즈덤@19 가동", isOpen(timelineFirstOnly, wisdomLg, wisdom19) === true);
  check("A 에세이@10 미가동", isOpen(timelineFirstOnly, essayLg, essay10) === false);
  check("A 에세이@19 미가동", isOpen(timelineFirstOnly, essayLg, essay19) === false);
  // floor-to-earliest: 확정(화00:00)보다 이른 액트(월요일)도 v1 지배.
  const mon10 = occ(1, "10:00");
  check("A floor-to-earliest(월요일 위즈덤 가동)", isOpen(timelineFirstOnly, wisdomLg, mon10) === true);
}

console.log("── 시나리오 B: 재실행(수 15:00) — 시점 경계 ──");
{
  check("B 위즈덤@10(변경 前) 가동 유지", isOpen(timelineAfterReexec, wisdomLg, wisdom10) === true);
  check("B 위즈덤@19(변경 後) 미가동", isOpen(timelineAfterReexec, wisdomLg, wisdom19) === false);
  check("B 에세이@10(변경 前) 미가동(소급X)", isOpen(timelineAfterReexec, essayLg, essay10) === false);
  check("B 에세이@19(변경 後) 가동", isOpen(timelineAfterReexec, essayLg, essay19) === true);
  // 경계값(정확히 15:00) = v2 적용(<= 이므로 신설정).
  check("B 경계값 15:00 = 신설정(에세이 가동)", isOpen(timelineAfterReexec, essayLg, tChange) === true);
  check("B 경계값 15:00 = 신설정(위즈덤 미가동)", isOpen(timelineAfterReexec, wisdomLg, tChange) === false);
}

console.log("── resolveConfigAtTime 직접 ──");
{
  check("변경 이전(수13:00) → v1", resolveConfigAtTime(versionsAfterReexec, occ(WED, "13:00")) === cfgV1);
  check("변경 이후(수16:00) → v2", resolveConfigAtTime(versionsAfterReexec, occ(WED, "16:00")) === cfgV2);
  // 첫 버전(화 00:00)보다 이른 시각 = 월요일 00:00 → v1(floor-to-earliest).
  check("첫 버전보다 이른 시각 → v1(floor)", resolveConfigAtTime(versionsAfterReexec, occ(1, "00:00")) === cfgV1);
  check("빈 버전 → null", resolveConfigAtTime([], wisdom10) === null);
}

console.log("── 폴백: timelineAvailable=false / occurMs=null → 최신 config ──");
{
  const tlUnavail: ActOpenTimeline = { ...timelineAfterReexec, timelineAvailable: false };
  // 마이그 전 = 전 액트가 최신(v2)로 판정(오늘 동작).
  check("마이그 전 위즈덤@10 = 최신(v2) 미가동", isOpen(tlUnavail, wisdomLg, wisdom10) === false);
  check("마이그 전 에세이@10 = 최신(v2) 가동", isOpen(tlUnavail, essayLg, essay10) === true);
  // occurMs=null(예외 액트) = 최신 config.
  check("occurMs=null → 최신(v2) 에세이 가동", isActOpenAtTime({ hub: "info", timeline: timelineAfterReexec, occurMs: null, lineGroupId: essayLg }) === true);
  // openConfirmed=false → 전부 미가동.
  const tlOff: ActOpenTimeline = { ...timelineAfterReexec, openConfirmed: false };
  check("openConfirmed=false → 위즈덤@10 미가동", isOpen(tlOff, wisdomLg, wisdom10) === false);
}

console.log("── 시나리오 D: 재실행 허용 조건(목요일 00:01 KST · 검수 완료) ──");
{
  // 목요일 00:01 = 월(06-01) + 3일 00:01 KST.
  const thu = weekThursdayBoundaryMs(WEEK_START);
  check("목요일 경계 = 06-04 00:01 KST", thu === Date.parse("2026-06-04T00:01:00+09:00"), { thu });
  const beforeThu = Date.parse("2026-06-03T23:00:00+09:00");
  const afterThu = Date.parse("2026-06-04T01:00:00+09:00");
  check("D 목요일 이전 + 미검수 → 재실행 허용", resolveReopenEligibility({ weekStartIso: WEEK_START, reviewStatus: "aggregating", nowMs: beforeThu }).reopenable === true);
  check("D 목요일 이후 → 차단(문구)", (() => { const e = resolveReopenEligibility({ weekStartIso: WEEK_START, reviewStatus: "aggregating", nowMs: afterThu }); return e.reopenable === false && e.reason === REOPEN_BLOCKED_PAST_THURSDAY; })());
  check("D 검수 완료(published) → 차단(문구·시각 무관)", (() => { const e = resolveReopenEligibility({ weekStartIso: WEEK_START, reviewStatus: "published", nowMs: beforeThu }); return e.reopenable === false && e.reason === REOPEN_BLOCKED_PUBLISHED; })());
  check("D reviewing(검수 중) + 이전 → 허용", resolveReopenEligibility({ weekStartIso: WEEK_START, reviewStatus: "reviewing", nowMs: beforeThu }).reopenable === true);
  check("D weekStart 없음 → fail-closed(차단)", resolveReopenEligibility({ weekStartIso: null, reviewStatus: "aggregating", nowMs: beforeThu }).reopenable === false);
}

async function probeTable(): Promise<void> {
  console.log("── DB 통합(테이블 존재 시에만) ──");
  try {
    const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
    const { error } = await supabaseAdmin
      .from("cluster4_week_opening_config_versions")
      .select("id")
      .limit(1);
    if (error) {
      console.log(`  ⏭  버전 테이블 미적용(마이그 대기) — 통합 테스트 스킵. (${error.code ?? error.message})`);
    } else {
      console.log("  ✅ 버전 테이블 존재 — loadWeekOpeningTimeline 조회 무오류.");
      const { loadWeekOpeningTimeline } = await import("@/lib/weekOpeningTimeline");
      // 아무 org/주차나 형태 확인(내용 무관·읽기 전용).
      const tl = await loadWeekOpeningTimeline("00000000-0000-0000-0000-000000000000", "encre");
      check("timelineAvailable=true(테이블 존재)", tl.timelineAvailable === true, tl);
      check("versions 배열", Array.isArray(tl.versions));
    }
  } catch (e) {
    console.log("  ⏭  DB 프로브 스킵(env/연결 없음):", e instanceof Error ? e.message : e);
  }
}

(async () => {
  await probeTable();
  console.log(`\n결과: ${pass} PASS · ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
