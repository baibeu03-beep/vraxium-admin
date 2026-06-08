/**
 * 주차별 허브 추가 개방(2026-06-08) 검증 — direct function 레벨.
 *
 * 증명 항목:
 *   (A) 기본 정규 기간이 닫힌 experience 라인은 override 없을 때 canEdit=false.
 *   (B) 해당 주차(week_id)에 work_exp override 를 열면 그 주차 카드만 canEdit=true(ok_override).
 *   (C) 다른 주차 카드는 그대로 false (= "전체 여는 구조" 아님, 주차 단위 동작).
 *   (D) 저장 게이트(front hasOpenEditWindowAny 동일 쿼리): weekId=대상주차 → 열림,
 *       weekId=다른주차 → 닫힘 (전역 행 없을 때).
 *   (E) markWeeklyCardsSnapshotStale → snapshot is_stale=true (canEdit 버튼 반영 트리거).
 *
 * read-only 가 아님: 검증용 override 1행을 넣었다 지우고, 마지막에 snapshot 을 재계산해 복원한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  markWeeklyCardsSnapshotStale,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const WORK_EXP = "cluster4.work_exp";
const VERIFY_NOTE = "verify-week-scope-temp";

type Line = {
  partType: string;
  canEdit: boolean;
  editReason: string;
  lineTargetId: string | null;
  weekId?: string | null;
};
type Card = { weekId: string | null; weekNumber?: number | null; lines: Line[] };

function expCard(cards: Card[], weekId: string): Line | null {
  const card = cards.find((c) => c.weekId === weekId);
  if (!card) return null;
  return card.lines.find((l) => l.partType === "experience") ?? null;
}

async function hasActiveOverride(
  userId: string,
  weekId: string | null,
): Promise<boolean> {
  // front lib/editWindow.ts hasOpenEditWindowAny 와 동일 쿼리 (work_exp + legacy).
  const now = new Date().toISOString();
  let q = supabaseAdmin
    .from("user_edit_windows")
    .select("id")
    .eq("user_id", userId)
    .in("resource_key", [WORK_EXP, "cluster4.activity_details"])
    .lte("opened_at", now)
    .gt("expires_at", now);
  if (weekId != null) q = q.or(`week_id.eq.${weekId},week_id.is.null`);
  const { data, error } = await q.limit(1);
  if (error) throw new Error("hasActiveOverride: " + error.message);
  return Array.isArray(data) && data.length > 0;
}

async function main() {
  const results: { name: string; pass: boolean; detail: string }[] = [];
  const rec = (name: string, pass: boolean, detail = "") =>
    results.push({ name, pass, detail });

  const nowIso = new Date().toISOString();

  // 1) 닫힌(submission_closes_at < now) experience 라인 타깃 후보 수집.
  const { data: cand, error: candErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(
      "id, week_id, target_user_id, cluster4_lines!inner(part_type, submission_closes_at, is_active)",
    )
    .eq("target_mode", "user")
    .eq("cluster4_lines.part_type", "experience")
    .eq("cluster4_lines.is_active", true)
    .lt("cluster4_lines.submission_closes_at", nowIso)
    .limit(200);
  if (candErr) throw new Error("candidate query: " + candErr.message);

  const byUser = new Map<string, Set<string>>(); // user -> set(weekId)
  for (const r of (cand ?? []) as Array<{
    week_id: string | null;
    target_user_id: string | null;
  }>) {
    if (!r.target_user_id || !r.week_id) continue;
    if (!byUser.has(r.target_user_id)) byUser.set(r.target_user_id, new Set());
    byUser.get(r.target_user_id)!.add(r.week_id);
  }
  console.log(`[setup] closed-exp candidate users: ${byUser.size}`);

  // 2) override 가 없고, builder 에서 exp 카드 canEdit=false 인 (user, week) 를 고른다.
  let picked: { userId: string; weekW: string; weekW2: string | null } | null =
    null;
  let attempts = 0;
  for (const [userId, weekSet] of byUser) {
    if (attempts >= 6) break;
    // 기존 active override(전역 포함) 가 있으면 깨끗한 검증이 안 되므로 스킵.
    if (await hasActiveOverride(userId, null)) continue;
    attempts++;
    let cards: Card[];
    try {
      cards = (await getCluster4WeeklyCardsForProfileUser(userId)) as Card[];
    } catch (e) {
      console.warn(`[setup] builder failed for ${userId}: ${String(e)}`);
      continue;
    }
    const closedWeeks = [...weekSet].filter((w) => {
      const l = expCard(cards, w);
      return l && l.canEdit === false && !!l.lineTargetId;
    });
    if (closedWeeks.length >= 1) {
      picked = {
        userId,
        weekW: closedWeeks[0],
        weekW2: closedWeeks[1] ?? null,
      };
      break;
    }
  }

  if (!picked) {
    console.error(
      "검증 대상(닫힌 experience 라인 + override 없음 + lineTargetId 보유)을 찾지 못했습니다.",
    );
    process.exit(2);
  }
  const { userId, weekW, weekW2 } = picked;
  console.log("[picked]", { userId, weekW, weekW2 });

  // (A) BEFORE: override 없을 때 W 카드 canEdit=false
  const before = (await getCluster4WeeklyCardsForProfileUser(userId)) as Card[];
  const beforeW = expCard(before, weekW)!;
  rec(
    "A. BEFORE override: W exp canEdit=false",
    beforeW.canEdit === false,
    `canEdit=${beforeW.canEdit} reason=${beforeW.editReason}`,
  );
  rec(
    "D0. save-gate BEFORE (weekId=W) closed",
    (await hasActiveOverride(userId, weekW)) === false,
    "",
  );

  // 검증용 잔여행 정리 후 주차별 override 삽입.
  await supabaseAdmin
    .from("user_edit_windows")
    .delete()
    .eq("user_id", userId)
    .eq("resource_key", WORK_EXP)
    .eq("note", VERIFY_NOTE);

  // week_id 파생 season_key (FK/감사용).
  const { data: weekRow } = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .eq("id", weekW)
    .maybeSingle();

  const opened = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  const { error: insErr } = await supabaseAdmin
    .from("user_edit_windows")
    .insert({
      user_id: userId,
      resource_key: WORK_EXP,
      week_id: weekW,
      season_key: (weekRow as { season_key: string | null } | null)?.season_key ?? null,
      opened_at: opened,
      expires_at: expires,
      note: VERIFY_NOTE,
    });
  if (insErr) throw new Error("insert override: " + insErr.message);
  console.log("[inserted] week-scoped work_exp override for weekW");

  // (B)(C) AFTER: W 카드만 canEdit=true, W2 는 그대로 false
  const after = (await getCluster4WeeklyCardsForProfileUser(userId)) as Card[];
  const afterW = expCard(after, weekW)!;
  rec(
    "B. AFTER override: W exp canEdit=true (ok_override)",
    afterW.canEdit === true,
    `canEdit=${afterW.canEdit} reason=${afterW.editReason}`,
  );
  if (weekW2) {
    const afterW2 = expCard(after, weekW2)!;
    rec(
      "C. AFTER override: 다른 주차(W2) exp canEdit=false (전역 아님)",
      afterW2.canEdit === false,
      `W2 canEdit=${afterW2.canEdit} reason=${afterW2.editReason}`,
    );
  } else {
    console.log("[note] 동일 유저의 두 번째 닫힌 주차가 없어 C(주차 격리)는 D로 대체 검증");
  }

  // (D) 저장 게이트: weekId=W 열림, weekId=다른주차 닫힘
  rec(
    "D1. save-gate AFTER (weekId=W) open",
    (await hasActiveOverride(userId, weekW)) === true,
    "",
  );

  // 주차 격리(핵심: "전체 여는 구조" 아님): W 가 아닌 임의의 다른 주차 카드를 골라
  //   - builder canEdit 이 override 영향 없이 BEFORE 와 동일하고
  //   - save-gate(다른주차)=false 임을 증명한다.
  const isoCard = after.find(
    (c) => c.weekId && c.weekId !== weekW && c.lines.some((l) => l.partType === "experience"),
  );
  if (isoCard?.weekId) {
    const isoWeek = isoCard.weekId;
    const isoAfter = expCard(after, isoWeek)!;
    const isoBefore = expCard(before, isoWeek);
    rec(
      "C. 다른 주차 exp canEdit 이 override 로 안 바뀜 (주차 격리)",
      !!isoBefore && isoAfter.canEdit === isoBefore.canEdit,
      `isoWeek canEdit before=${isoBefore?.canEdit} after=${isoAfter.canEdit}`,
    );
    rec(
      "D2. save-gate AFTER (다른 주차) closed (전역 아님)",
      (await hasActiveOverride(userId, isoWeek)) === false,
      `isoWeek=${isoWeek}`,
    );
  } else {
    console.log("[note] 다른 주차 experience 카드가 없어 C/D2 격리 검증 생략");
  }

  // (E) snapshot stale 트리거
  await markWeeklyCardsSnapshotStale(userId);
  const { data: snapRow } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale")
    .eq("user_id", userId)
    .maybeSingle();
  rec(
    "E. markWeeklyCardsSnapshotStale → is_stale=true",
    (snapRow as { is_stale: boolean } | null)?.is_stale === true ||
      snapRow === null /* 신규 유저면 행 없음=다음 조회 miss→recompute */,
    `is_stale=${(snapRow as { is_stale: boolean } | null)?.is_stale ?? "no-row"}`,
  );

  // cleanup: override 삭제 후 snapshot 재계산(복원).
  await supabaseAdmin
    .from("user_edit_windows")
    .delete()
    .eq("user_id", userId)
    .eq("resource_key", WORK_EXP)
    .eq("note", VERIFY_NOTE);
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  console.log("[cleanup] override 삭제 + snapshot 재계산 완료");

  // 결과 출력
  console.log("\n==== RESULT ====");
  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  | " + r.detail : ""}`);
  }
  console.log("\nALL:", allPass ? "PASS ✅" : "FAIL ❌");
  console.log("picked:", JSON.stringify(picked));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
