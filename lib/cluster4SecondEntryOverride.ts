// Cluster4 라인 "2차 기입(라인 칸 제출) 편집권" 관리자 수동 override — read-time overlay + 저장 가드 조회.
//
// 정책(사용자 확정 2026-07-16 — force-open + 회수):
//   - "허용"(allowed=true) = 클럽 오픈 + 강화 성공 라인에 한해 자동 기간이 끝나도 canEdit 을 force-open.
//     자격(클럽오픈 && 강화성공)은 쓰기(관리자 API) 시점에 강제한다 — 이 overlay 는 조회 시 그 자격을
//     한 번 더 확인(방어)하고 자격 불충족이면 override 를 무시한다.
//   - "불가"(allowed=false / 행 부재) = override 회수 → 자동 기간 로직으로 복귀(force-close 아님).
//   - snapshot 에는 굽지 않는다. loadWeeklyCards 반환 직전에만 canEdit 을 보정(선례: enhancement override).
//   - 저장 경로(크루 2차 기입 저장)는 evaluateCluster4HubEdit 결과가 "시간창"으로만 막힐 때
//     isSecondEntryOverrideAllowed 로 force-open 여부를 재확인한다(소유권/미오픈은 override 무관하게 차단).
//   - 공용 편집권 엔진(cluster4LinePermission.ts)은 무수정 — 이 override 는 overlay + 가드에서만 소비.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  Cluster4LineDetailDto,
  Cluster4LineEditReason,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";

const TABLE = "cluster4_line_second_entry_overrides";

export type Cluster4LineSecondEntryOverrideRow = {
  id: string;
  user_id: string;
  week_id: string;
  line_id: string;
  allowed: boolean;
  source: string;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLUMNS =
  "id,user_id,week_id,line_id,allowed,source,note,created_by,updated_by,created_at,updated_at";

// 라인이 "수동 허용 자격"을 갖췄는지 — 클럽 오픈(개설된 실제 라인) + 본인 배정 + 강화 성공.
//   · 클럽 오픈 = lineId != null (placeholder/미개설 라인은 lineId 없음).
//   · 본인 배정 = lineTargetId != null (미배정 라인은 override 대상 아님 — 소유권).
//   · 강화 성공 = enhancementStatus === "success".
export function isSecondEntryEligibleLine(line: Cluster4LineDetailDto): boolean {
  return (
    line.lineId != null &&
    line.lineTargetId != null &&
    line.enhancementStatus === "success"
  );
}

// 한 사용자의 모든 2차 기입 override 를 로드(카드 조회당 1 SELECT). 테이블 미존재 등 실패 → [] (fail-open).
export async function loadSecondEntryOverridesForUser(
  userId: string,
): Promise<Cluster4LineSecondEntryOverrideRow[]> {
  if (!userId) return [];
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq("user_id", userId);
  if (error) {
    console.warn("[cluster4/second-entry-override] load failed → treat as none", {
      userId,
      message: error.message,
    });
    return [];
  }
  return (data ?? []) as Cluster4LineSecondEntryOverrideRow[];
}

// read-time overlay: 자격 있는(클럽오픈+배정+성공) 라인에 allowed=true override 가 있으면 canEdit=true 로.
//   이미 편집 가능(자동 기간)한 라인은 그대로. override/매칭 없음 → 입력 cards 동일 참조 반환(회귀 0).
export async function applySecondEntryOverridesToCards(
  userId: string,
  cards: Cluster4WeeklyCardDto[],
): Promise<Cluster4WeeklyCardDto[]> {
  if (!userId || !Array.isArray(cards) || cards.length === 0) return cards;

  const rows = (await loadSecondEntryOverridesForUser(userId)).filter((r) => r.allowed);
  if (rows.length === 0) return cards;

  let anyCardChanged = false;
  const next = cards.map((card) => {
    const cardWeekId = card.weekId ?? null;
    if (!cardWeekId || !Array.isArray(card.lines) || card.lines.length === 0) return card;
    const candidates = rows.filter((r) => r.week_id === cardWeekId);
    if (candidates.length === 0) return card;

    let lineChanged = false;
    const lines = card.lines.map((line) => {
      if (line.canEdit) return line; // 이미 편집 가능(자동 기간) — 변경 불필요
      if (!isSecondEntryEligibleLine(line)) return line; // 미오픈/미배정/비성공 → override 무시
      const match = candidates.find((r) => r.line_id === line.lineId);
      if (!match) return line;
      lineChanged = true;
      return {
        ...line,
        canEdit: true,
        editReason: "ok_override" as Cluster4LineEditReason,
      };
    });
    if (!lineChanged) return card;
    anyCardChanged = true;
    return { ...card, lines };
  });

  return anyCardChanged ? next : cards;
}

// 저장 가드용 단건 조회 — (user, week, line) 에 활성(allowed=true) override 가 있는가.
export async function isSecondEntryOverrideAllowed(
  userId: string,
  weekId: string,
  lineId: string,
): Promise<boolean> {
  if (!userId || !weekId || !lineId) return false;
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("allowed")
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("line_id", lineId)
    .maybeSingle();
  if (error) {
    console.warn("[cluster4/second-entry-override] lookup failed → treat as not allowed", {
      userId,
      weekId,
      lineId,
      message: error.message,
    });
    return false;
  }
  return (data as { allowed: boolean } | null)?.allowed === true;
}

// find-then-write (멱등) — (user, week, line) 1행. 동일 값 재적용 = no-op(changed:false).
//   allowed=false 인데 기존 행이 없으면 닫을 대상이 없으므로 no-op(빈 tombstone 생성 금지).
export async function writeSecondEntryOverride(params: {
  userId: string;
  weekId: string;
  lineId: string;
  allowed: boolean;
  adminUserId: string | null;
  source: "admin_manual" | "admin_bulk";
  note?: string | null;
}): Promise<{ changed: boolean; allowed: boolean }> {
  const { userId, weekId, lineId, allowed, adminUserId, source, note } = params;
  const nowIso = new Date().toISOString();

  const { data: existing, error: findErr } = await supabaseAdmin
    .from(TABLE)
    .select("id,allowed")
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("line_id", lineId)
    .maybeSingle();
  if (findErr) throw findErr;

  const row = existing as { id: string; allowed: boolean } | null;

  if (row) {
    if (row.allowed === allowed) return { changed: false, allowed }; // 멱등 no-op
    const { error: upErr } = await supabaseAdmin
      .from(TABLE)
      .update({ allowed, updated_by: adminUserId, source, note: note ?? null, updated_at: nowIso })
      .eq("id", row.id);
    if (upErr) throw upErr;
    return { changed: true, allowed };
  }

  if (!allowed) return { changed: false, allowed: false }; // 닫을 기존 행 없음 → no-op

  const { error: insErr } = await supabaseAdmin.from(TABLE).insert({
    user_id: userId,
    week_id: weekId,
    line_id: lineId,
    allowed: true,
    source,
    note: note ?? null,
    created_by: adminUserId,
    updated_by: adminUserId,
    updated_at: nowIso,
  });
  if (insErr) throw insErr;
  return { changed: true, allowed: true };
}

// 전체 불가 — 이 (user, week) 의 현재 allowed=true override 를 모두 닫는다(비정상 자격 포함 안전 정리).
//   반환: 닫은 line_id 목록.
export async function denyAllSecondEntryOverridesForUserWeek(params: {
  userId: string;
  weekId: string;
  adminUserId: string | null;
}): Promise<string[]> {
  const { userId, weekId, adminUserId } = params;
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("id,line_id")
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("allowed", true);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; line_id: string }>;
  if (rows.length === 0) return [];
  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabaseAdmin
    .from(TABLE)
    .update({ allowed: false, updated_by: adminUserId, source: "admin_bulk", updated_at: nowIso })
    .in(
      "id",
      rows.map((r) => r.id),
    );
  if (upErr) throw upErr;
  return rows.map((r) => r.line_id);
}
