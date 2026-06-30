// 운영 자동 fallback — 주차 공표/검수 자동 실행 sweep (서버 인프로세스).
//
//   "수동 우선 + 미실행 시 자동 fallback" 구조. 자동 실행은 수동 버튼과 **동일한 Action Service**
//   (publishWeekResult / markWeekResultReviewed)를 scope='operating' 으로 호출한다 — 차이는
//   호출 주체(스케줄러)뿐. 새 자동 전용 로직을 만들지 않는다.
//
//   자동 데드라인(KST, weeks.end_date=주차 종료 일요일 기준):
//     · 공표 publish : N+1주차 목 14:00 KST = end_date + 4일 14:00
//     · 검수 review  : N+1주차 금 16:00 KST = end_date + 5일 16:00 (공표 선행 필수)
//
//   멱등 / 중복 방지:
//     · 이미 수동/이전-자동 처리된 주차는 Action Service 의 409("이미 공표/검수") + .is(...,null)
//       race 가드로 자동 skip → 같은 주차를 여러 번 호출해도 운영 데이터 중복 변경 없음.
//     · 실패는 다음 주기 재시도(주차가 여전히 due+미처리 → 자연 재시도). attempt_count 불필요.
//
//   QA 격리: scope='operating' 고정 — qa_weeks_state 등 QA overlay 를 절대 건드리지 않는다.
//   호출: POST /api/admin/weeks/run-due-week-actions (내부 키) ← GitHub Actions 스케줄러.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  publishWeekResult,
  markWeekResultReviewed,
  WeekResultPublishError,
  WeekResultReviewError,
} from "@/lib/adminWeekRecognitionsData";

const DEFAULT_MAX_ITEMS = Number(process.env.WEEK_AUTO_ACTIONS_MAX_ITEMS ?? 50);
const AUTO_ACTOR = "auto-fallback";

// KST 정확 계산: endDate("YYYY-MM-DD", 주차 종료 KST 날짜) + addDays 일의 hhmm KST 시각(ms).
//   날짜 가산은 UTC 자정 기준(KST는 DST 없음) → toISOString 으로 날짜 추출 → +09:00 오프셋으로 시각 확정.
function cutoffMs(endDate: string, addDays: number, hhmm: string): number {
  const d = new Date(`${endDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  const targetDate = d.toISOString().slice(0, 10);
  return Date.parse(`${targetDate}T${hhmm}:00+09:00`);
}
// 공표 자동 데드라인 = N+1 목 14:00 KST. (end_date=일 → +4일=목)
export const publishCutoffMs = (endDate: string) => cutoffMs(endDate, 4, "14:00");
// 검수 자동 데드라인 = N+1 금 16:00 KST. (end_date=일 → +5일=금)
export const reviewCutoffMs = (endDate: string) => cutoffMs(endDate, 5, "16:00");

type WeekRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  is_official_rest: boolean | null;
  result_published_at: string | null;
  result_reviewed_at: string | null;
};
type Outcome = "done" | "skipped" | "failed";
export type WeekAutoItem = {
  action: "publish" | "review";
  weekId: string;
  weekStart: string | null;
  outcome: Outcome;
  cutoffIso: string;
  error?: string;
  resultAt?: string | null;
};
export type WeekAutoActionResult = {
  nowIso: string;
  publish: { due: number; done: number; skipped: number; failed: number };
  review: { due: number; done: number; skipped: number; failed: number };
  capped: number;
  items: WeekAutoItem[];
};

// 감사 로그 1행(best-effort — 로깅 실패가 액션을 막지 않는다).
async function logAuto(
  action: "publish" | "review",
  week: WeekRow,
  outcome: Outcome,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("week_auto_action_log").insert({
      action,
      week_id: week.id,
      week_start_date: week.start_date,
      outcome,
      detail,
      actor: AUTO_ACTOR,
    });
    if (error) console.warn("[run-due-week-actions] audit log insert failed", { action, weekId: week.id, message: error.message });
  } catch (e) {
    console.warn("[run-due-week-actions] audit log threw", { message: e instanceof Error ? e.message : String(e) });
  }
}

export async function runDueWeekActionsSweep(opts: {
  now?: number;
  onlyIds?: string[] | null;       // 진단/검증용(자기 시드만) — 운영은 미지정
  maxItems?: number;
  log?: (m: string) => void;
  actor?: string | null;
  // dryRun=true → due 주차만 식별하고 실제 Action Service 는 호출하지 않는다(운영 데이터 무변경).
  //   진단/검증용 — 운영 스케줄러는 미지정(=실행). 식별된 due 는 items[outcome='skipped',reason='dryRun'].
  dryRun?: boolean;
} = {}): Promise<WeekAutoActionResult> {
  const now = opts.now ?? Date.now();
  const onlyIds = opts.onlyIds ?? null;
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  const log = opts.log ?? (() => {});
  const actor = opts.actor ?? AUTO_ACTOR;
  const dryRun = opts.dryRun === true;
  const nowIso = new Date(now).toISOString();

  // 후보 주차 로드: 종료됐고(end_date 존재) 미공표거나 공표·미검수인 주차만(소수). cutoff 는 JS 에서 정밀 판정.
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,is_official_rest,result_published_at,result_reviewed_at")
    .not("end_date", "is", null)
    .order("end_date", { ascending: true });
  if (error) throw new Error(error.message);
  const weeks = (data ?? []) as WeekRow[];

  const result: WeekAutoActionResult = {
    nowIso,
    publish: { due: 0, done: 0, skipped: 0, failed: 0 },
    review: { due: 0, done: 0, skipped: 0, failed: 0 },
    capped: 0,
    items: [],
  };

  // ── 공표 due: 미공표 · 非휴식 · now >= N+1 목 14:00 KST ──
  const publishDue = weeks.filter(
    (w) =>
      w.end_date != null &&
      !w.result_published_at &&
      !w.is_official_rest &&
      (!onlyIds || onlyIds.includes(w.id)) &&
      now >= publishCutoffMs(w.end_date),
  );
  // ── 검수 due: 공표완료 · 미검수 · now >= N+1 금 16:00 KST ──
  const reviewDue = weeks.filter(
    (w) =>
      w.end_date != null &&
      !!w.result_published_at &&
      !w.result_reviewed_at &&
      (!onlyIds || onlyIds.includes(w.id)) &&
      now >= reviewCutoffMs(w.end_date),
  );
  result.publish.due = publishDue.length;
  result.review.due = reviewDue.length;

  // maxItems 캡(공표 먼저, 그 다음 검수). 초과분은 다음 주기 catch-up.
  const budget = maxItems;
  const publishBatch = publishDue.slice(0, budget);
  const reviewBatch = reviewDue.slice(0, Math.max(0, budget - publishBatch.length));
  result.capped = (publishDue.length - publishBatch.length) + (reviewDue.length - reviewBatch.length);
  if (result.capped > 0) log(`⚠ maxItems=${maxItems} 도달 — ${result.capped}건 다음 주기로 미룸`);

  // dryRun: due 주차만 보고하고 실제 변경/로깅 없이 반환(운영 데이터 무변경 검증용).
  if (dryRun) {
    for (const w of publishBatch) result.items.push({ action: "publish", weekId: w.id, weekStart: w.start_date, outcome: "skipped", cutoffIso: new Date(publishCutoffMs(w.end_date!)).toISOString(), error: "dryRun" });
    for (const w of reviewBatch) result.items.push({ action: "review", weekId: w.id, weekStart: w.start_date, outcome: "skipped", cutoffIso: new Date(reviewCutoffMs(w.end_date!)).toISOString(), error: "dryRun" });
    return result;
  }

  // ── 공표 실행 — 수동 버튼과 동일 publishWeekResult(scope=operating) ──
  for (const w of publishBatch) {
    const cutoffIso = new Date(publishCutoffMs(w.end_date!)).toISOString();
    try {
      const r = await publishWeekResult(w.id, "operating", actor);
      result.publish.done++;
      result.items.push({ action: "publish", weekId: w.id, weekStart: w.start_date, outcome: "done", cutoffIso, resultAt: r.result_published_at });
      await logAuto("publish", w, "done", { cutoffIso, resultAt: r.result_published_at, snapshotRecompute: r.snapshot_recompute });
      log(`✓ publish ${w.start_date} (${w.id}) → ${r.result_published_at}`);
    } catch (e) {
      if (e instanceof WeekResultPublishError && e.status === 409) {
        // 이미 수동/이전-자동 공표됨 → skip(정상). 변경 없음.
        result.publish.skipped++;
        result.items.push({ action: "publish", weekId: w.id, weekStart: w.start_date, outcome: "skipped", cutoffIso, error: e.message });
        await logAuto("publish", w, "skipped", { cutoffIso, reason: e.message });
        log(`↷ publish skip(이미 공표) ${w.start_date}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        result.publish.failed++;
        result.items.push({ action: "publish", weekId: w.id, weekStart: w.start_date, outcome: "failed", cutoffIso, error: msg });
        await logAuto("publish", w, "failed", { cutoffIso, error: msg });
        log(`✗ publish ${w.start_date}: ${msg}`);
      }
    }
  }

  // ── 검수 실행 — 수동 버튼과 동일 markWeekResultReviewed(scope=operating) ──
  for (const w of reviewBatch) {
    const cutoffIso = new Date(reviewCutoffMs(w.end_date!)).toISOString();
    try {
      const r = await markWeekResultReviewed(w.id, "operating", actor);
      result.review.done++;
      result.items.push({ action: "review", weekId: w.id, weekStart: w.start_date, outcome: "done", cutoffIso, resultAt: r.result_reviewed_at });
      await logAuto("review", w, "done", { cutoffIso, resultAt: r.result_reviewed_at });
      log(`✓ review ${w.start_date} (${w.id}) → ${r.result_reviewed_at}`);
    } catch (e) {
      if (e instanceof WeekResultReviewError && e.status === 409) {
        result.review.skipped++;
        result.items.push({ action: "review", weekId: w.id, weekStart: w.start_date, outcome: "skipped", cutoffIso, error: e.message });
        await logAuto("review", w, "skipped", { cutoffIso, reason: e.message });
        log(`↷ review skip(이미 검수/미공표) ${w.start_date}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        result.review.failed++;
        result.items.push({ action: "review", weekId: w.id, weekStart: w.start_date, outcome: "failed", cutoffIso, error: msg });
        await logAuto("review", w, "failed", { cutoffIso, error: msg });
        log(`✗ review ${w.start_date}: ${msg}`);
      }
    }
  }

  return result;
}
