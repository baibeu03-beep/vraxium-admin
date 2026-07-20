import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  fetchExperienceRequiredSlotStatusByWeek,
  mapExperienceVerdictToWeekStatus,
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
} from "@/lib/lineAvailability";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recalcUserGrowthStatsForUsers } from "@/lib/userGrowthStatsData";
import { resyncGradeStatsBatch } from "@/lib/cluster3ClubRankData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { mapWithConcurrency, GROWTH_CARD_CONCURRENCY } from "@/lib/concurrency";

// ─────────────────────────────────────────────────────────────────────
// 액트 보완/취소 후 "그 크루·그 주차"의 성장 결과(uws.status)를 기존 판정 SoT 로 다시 판정한다.
//   · 새 판정 공식 없음 — finalizeWeekUws 가 쓰는 것과 동일한 엔진
//     (fetchExperienceRequiredSlotStatusByWeek)과 동일한 매핑(mapExperienceVerdictToWeekStatus)을
//     단일 사용자 스코프로 적용한다. 주차 전체 코호트를 건드리지 않아 다른 크루 결과는 불변.
//   · 양방향: 포인트가 기준(N)을 넘으면 fail→success, 밑돌면 success→fail (finalize 와 동일).
//   · 휴식 보호: 개인/공식 휴식 주차·기존 rest uws 행은 절대 덮지 않는다(skip).
//   · 순서 계약: 반드시 user_weekly_points 재집계 "후" 호출해야 최신 earned(Point A)로 판정한다.
//   · predictWeekStatusForUser(순수 읽기)를 미리보기와 커밋이 공유 → "미리보기 == 실제 결과" 보장.
// ─────────────────────────────────────────────────────────────────────

type WeekRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
  is_official_rest: boolean | null;
};

// 판정 예측(순수 읽기 — uws 미변경). 커밋(rejudge)·미리보기(preview)가 공유하는 결정 로직.
export type WeekStatusPrediction = {
  skipped: boolean; // uws 를 건드리지 않음(레거시/휴식/공식휴식/not_applicable/pending 등)
  skipReason?: string;
  targetStatus: "success" | "fail" | null; // 확정 대상 상태 — skip 이면 null
  existing: { id: string; status: string } | null; // 재판정 직전 uws 행(없으면 null)
};

export type RejudgeResult = {
  skipped: boolean;
  skipReason?: string;
  changed: boolean; // uws.status 가 실제로 바뀌었는가
  prevStatus: string | null; // 재판정 직전 uws 상태(행 없으면 null)
  newStatus: string | null; // 재판정 결과 상태(success|fail) — skip 이면 null
};

async function loadWeekRow(weekId: string): Promise<WeekRow | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest")
    .eq("id", weekId)
    .maybeSingle();
  return (data as WeekRow | null) ?? null;
}

// 그 크루가 그 주차에 휴식(시즌 전체 휴식 또는 개인 휴식 기간 겹침)인가 — finalize 의 rest 우선 규칙과 동일 소스.
async function isUserRestForWeek(userId: string, week: WeekRow): Promise<boolean> {
  const weekStart = week.start_date as string;
  const weekEnd =
    week.end_date ??
    new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);

  const { data: restRows } = await supabaseAdmin
    .from("crew_personal_rest_periods")
    .select("user_id")
    .eq("user_id", userId)
    .lte("start_date", weekEnd)
    .gte("end_date", weekStart)
    .limit(1);
  if ((restRows ?? []).length > 0) return true;

  if (week.season_key) {
    const { data: ussRows } = await supabaseAdmin
      .from("user_season_statuses")
      .select("status")
      .eq("user_id", userId)
      .eq("season_key", week.season_key)
      .eq("status", "rest")
      .limit(1);
    if ((ussRows ?? []).length > 0) return true;
  }
  return false;
}

// 순수 읽기 판정 — uws 를 쓰지 않고 "확정 대상 상태"를 결정한다.
//   earnedOverride 전달 시 그 주차 earned(Point A)를 가상값으로 대체(미리보기). 미전달 = DB 실값(커밋).
export async function predictWeekStatusForUser(params: {
  userId: string;
  weekId: string;
  organizationSlug: OrganizationSlug | null;
  earnedOverride?: number; // 그 주차 가상 Point A(미리보기)
  now?: number;
}): Promise<WeekStatusPrediction> {
  const { userId, weekId, organizationSlug } = params;
  const now = params.now ?? Date.now();
  const skip = (
    reason: string,
    existing: { id: string; status: string } | null,
  ): WeekStatusPrediction => ({ skipped: true, skipReason: reason, targetStatus: null, existing });

  const week = await loadWeekRow(weekId);
  if (!week) return skip("week_not_found", null);
  if (!week.start_date || !week.season_key || week.iso_year == null || week.iso_week == null) {
    return skip("week_meta_missing", null);
  }
  // finalize 와 동일 게이트: 레거시(허브 도입 전)·공식휴식 주차는 uws 재판정 대상 아님.
  if (week.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) return skip("legacy_week", null);
  if (week.is_official_rest === true) return skip("official_rest_week", null);

  // 기존 uws 행(생성/갱신 판별 + 휴식 보호). 키 = (week_start_date, user_id).
  const { data: existingRows } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id,status")
    .eq("week_start_date", week.start_date)
    .eq("user_id", userId)
    .limit(1);
  const existing = ((existingRows ?? []) as { id: string; status: string }[])[0] ?? null;

  // 휴식 보호: 기존 rest 행/그 주차 휴식이면 success/fail 을 쓰지 않는다(finalize rest 우선과 정합).
  if (existing && (existing.status === "personal_rest" || existing.status === "official_rest")) {
    return skip("rest_protected", existing);
  }
  if (await isUserRestForWeek(userId, week)) return skip("rest_week", existing);

  // 판정: 기존 엔진 그대로(공표된 신정책 주차 = 필수 슬롯 항상-개설). earned 는 DB 최신 uwp(또는 가상값).
  let mapped: ReturnType<typeof mapExperienceVerdictToWeekStatus>;
  try {
    const vmap = await fetchExperienceRequiredSlotStatusByWeek(userId, [weekId], now, {
      alwaysOpenWeekIds: new Set([weekId]),
      organizationSlug,
      earnedOverride:
        params.earnedOverride != null ? new Map([[weekId, params.earnedOverride]]) : undefined,
    });
    const v = vmap.get(weekId);
    mapped = v ? mapExperienceVerdictToWeekStatus(v.status) : "skip";
  } catch (e) {
    console.warn("[crew-week-rejudge] verdict 계산 실패 — uws 미변경(보존)", {
      userId,
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
    return skip("verdict_error", existing);
  }

  // not_applicable(skip)·pending(block) → uws 미생성/미변경(finalize 와 동일 — 과거 결과 보존).
  if (mapped === "skip" || mapped === "block") {
    return skip(mapped === "block" ? "pending" : "not_applicable", existing);
  }
  return { skipped: false, targetStatus: mapped, existing };
}

// 단일 사용자·단일 주차 성장 결과 재판정 (side-effect: user_week_statuses 1행만). predict + write.
export async function rejudgeWeekStatusForUser(params: {
  userId: string;
  weekId: string;
  organizationSlug: OrganizationSlug | null;
  now?: number;
}): Promise<RejudgeResult> {
  const now = params.now ?? Date.now();
  const pred = await predictWeekStatusForUser({ ...params, now });
  if (pred.skipped) {
    return {
      skipped: true,
      skipReason: pred.skipReason,
      changed: false,
      prevStatus: pred.existing?.status ?? null,
      newStatus: null,
    };
  }
  const target = pred.targetStatus as "success" | "fail";
  const existing = pred.existing;
  const nowIso = new Date(now).toISOString();

  if (existing) {
    if (existing.status === target) {
      return { skipped: false, changed: false, prevStatus: existing.status, newStatus: target };
    }
    const { error } = await supabaseAdmin
      .from("user_week_statuses")
      .update({ status: target, updated_at: nowIso })
      .eq("id", existing.id);
    if (error) {
      console.warn("[crew-week-rejudge] uws update 실패(보존)", {
        userId: params.userId,
        weekId: params.weekId,
        message: error.message,
      });
      return { skipped: true, skipReason: "update_failed", changed: false, prevStatus: existing.status, newStatus: null };
    }
    return { skipped: false, changed: true, prevStatus: existing.status, newStatus: target };
  }

  // 행이 없으면 신규 생성(finalize insert 계약과 동일 컬럼).
  const week = await loadWeekRow(params.weekId);
  const { error: insErr } = await supabaseAdmin.from("user_week_statuses").insert({
    user_id: params.userId,
    year: week?.iso_year,
    week_number: week?.iso_week,
    week_start_date: week?.start_date,
    season_key: week?.season_key,
    status: target,
    is_official_rest_override: false,
  });
  if (insErr) {
    console.warn("[crew-week-rejudge] uws insert 실패(보존)", {
      userId: params.userId,
      weekId: params.weekId,
      message: insErr.message,
    });
    return { skipped: true, skipReason: "insert_failed", changed: false, prevStatus: null, newStatus: null };
  }
  return { skipped: false, changed: true, prevStatus: null, newStatus: target };
}

// 그 주차(iso year/week)에 user_weekly_points 행을 가진 전 사용자 = 상대 백분위(품계)가 밀릴 수 있는 스코프.
async function fetchWeekParticipantUserIds(isoYear: number, isoWeek: number): Promise<string[]> {
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id")
      .eq("year", isoYear)
      .eq("week_number", isoWeek)
      .order("user_id")
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("[crew-week-rejudge] 주차 참여자 조회 실패 — 품계 재동기 스킵", { message: error.message });
      return [];
    }
    const rows = (data ?? []) as { user_id: string | null }[];
    for (const r of rows) if (r.user_id) ids.add(r.user_id);
    if (rows.length < PAGE) break;
  }
  return [...ids];
}

// 커밋 후 파생 재계산 체인 — 액트 보완/취소가 공유한다(uwp 재집계는 호출부가 이미 수행).
//   uws 재판정 → 카드 snapshot 재생성 → 성장 통계(주차 수) → 품계(주차 참여자 스코프).
//   각 파생 단계는 best-effort(실패해도 이미 커밋된 포인트/액트를 되돌리지 않음 — 로그 후 다음 배치 수렴).
export async function recomputeDerivedAfterActMutation(params: {
  userId: string;
  weekId: string;
  organizationSlug?: OrganizationSlug | null;
}): Promise<RejudgeResult> {
  const { userId, weekId } = params;

  // organizationSlug 미전달 시 프로필에서 해석(recognition N 기준값 조회에 필요).
  let org: OrganizationSlug | null = params.organizationSlug ?? null;
  if (params.organizationSlug === undefined) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", userId)
      .maybeSingle();
    const slug = (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
    org = slug && isOrganizationSlug(slug) ? slug : null;
  }

  // 1) 성장 결과(uws) 재판정.
  const rejudge = await rejudgeWeekStatusForUser({ userId, weekId, organizationSlug: org });

  // 2) 카드 snapshot 재생성(uws 변경 후) — 결정적 즉시 반영.
  try {
    await recomputeWeeklyCardsSnapshotsForUsers([userId], { concurrency: 4 });
  } catch (e) {
    console.warn("[crew-week-rejudge] snapshot 재생성 실패(best-effort)", {
      userId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 3) 성장 통계(누적/승인 주차) — uws.status 변동 시에만 값이 바뀌지만 멱등이라 항상 호출.
  try {
    await recalcUserGrowthStatsForUsers([userId]);
  } catch (e) {
    console.warn("[crew-week-rejudge] 성장 통계 재계산 실패(best-effort)", {
      userId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 4) 품계 재동기(상대 백분위 → 그 주차 참여자 전원 스코프). 실패해도 다음 배치에서 수렴.
  try {
    const week = await loadWeekRow(weekId);
    if (week?.iso_year != null && week.iso_week != null) {
      const participants = await fetchWeekParticipantUserIds(week.iso_year, week.iso_week);
      if (participants.length > 0) await resyncGradeStatsBatch(participants);
    }
  } catch (e) {
    console.warn("[crew-week-rejudge] 품계 재동기 실패(best-effort)", {
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  return rejudge;
}

// ── 배치판 — 여러 사용자의 파생 재계산을 "코호트 1회"로 수행(라인 개설 등 다수 사용자 동시 변경) ──
//   단일 사용자판(recomputeDerivedAfterActMutation)을 N회 직렬 호출하면:
//     (a) resyncGradeStatsBatch(주차 참여자 전원 P)가 N회 = O(N·P) 재계산,
//     (b) uws 재판정·스냅샷·성장통계가 유저별 직렬로 반복된다.
//   이 함수는 **동일한 파생 결과**를 유지하면서 rejudge=동시성 / 스냅샷·성장통계=배치 / 품계 재동기=1회
//   로 묶어 O(N·P) → O(N+P) 로 낮춘다. ⚠ 새 계산식 없음 — 기존 함수(rejudgeWeekStatusForUser·
//   recomputeWeeklyCardsSnapshotsForUsers·recalcUserGrowthStatsForUsers·resyncGradeStatsBatch)의
//   스코프만 코호트로 바꿔 조립한다(단일판을 N회 호출한 것과 결과 동일·멱등).
export async function recomputeDerivedAfterActMutationForUsers(params: {
  userIds: Array<string | null | undefined>;
  weekId: string;
}): Promise<void> {
  const { weekId } = params;
  const uniq = Array.from(new Set(params.userIds.filter((u): u is string => Boolean(u))));
  if (uniq.length === 0) return;

  // org 배치 해석(단일판은 user_profiles 를 유저별 1회 조회) — recognition N 기준값 조회에 필요.
  //   여기선 코호트 전체를 1회 조회해 맵으로 전달한다(유저별 반복 조회 제거, 동일 값).
  const orgByUser = new Map<string, OrganizationSlug | null>();
  {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", uniq);
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      const slug = r.organization_slug;
      orgByUser.set(r.user_id, slug && isOrganizationSlug(slug) ? slug : null);
    }
  }

  // 1) uws 재판정 — 유저별(동시성). 단일판과 동일 엔진·org 해석, 스코프만 코호트.
  await mapWithConcurrency(uniq, GROWTH_CARD_CONCURRENCY, async (userId) => {
    try {
      await rejudgeWeekStatusForUser({
        userId,
        weekId,
        organizationSlug: orgByUser.get(userId) ?? null,
      });
    } catch (e) {
      console.warn("[crew-week-rejudge][batch] uws 재판정 실패(격리)", {
        userId,
        weekId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // 2) 카드 snapshot 배치 재생성(유저별 직렬 → 배치·동시성 8).
  try {
    await recomputeWeeklyCardsSnapshotsForUsers(uniq, { concurrency: GROWTH_CARD_CONCURRENCY });
  } catch (e) {
    console.warn("[crew-week-rejudge][batch] snapshot 재생성 실패(best-effort)", {
      count: uniq.length,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 3) 성장 통계 배치(1회).
  try {
    await recalcUserGrowthStatsForUsers(uniq);
  } catch (e) {
    console.warn("[crew-week-rejudge][batch] 성장 통계 재계산 실패(best-effort)", {
      count: uniq.length,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  // 4) 품계 재동기 — 주차 참여자 전원 스코프로 "1회"(기존: 유저별 N회 → N×P 중복 제거).
  try {
    const week = await loadWeekRow(weekId);
    if (week?.iso_year != null && week.iso_week != null) {
      const participants = await fetchWeekParticipantUserIds(week.iso_year, week.iso_week);
      if (participants.length > 0) await resyncGradeStatsBatch(participants);
    }
  } catch (e) {
    console.warn("[crew-week-rejudge][batch] 품계 재동기 실패(best-effort)", {
      weekId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
