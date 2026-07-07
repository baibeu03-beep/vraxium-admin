import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { assertUserInRequestScope } from "@/lib/userScope";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadEnhancementOverridesForUser } from "@/lib/cluster4EnhancementOverride";
import type {
  Cluster4EnhancementStatus,
  Cluster4LinePartType,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";

// 크루별 라인 강화 상태(enhancementStatus) 수동 override 관리 API.
//   - GET   ?user_id=<uuid> : 자동 계산값(raw snapshot 라인) + 현재 override 목록.
//   - POST  { user_id, week_id, part_type, line_target_id?/line_id?/line_code?, override_status, note? }
//   - DELETE ?id=<uuid>     : override 해제(행 삭제 → 자동 계산값으로 복귀).
//
// ⚠ override 는 read-time overlay(lib/cluster4EnhancementOverride.ts) 로만 적용된다. snapshot 을
//   재계산/무효화하지 않는다 — 고객 조회(loadWeeklyCards)가 매 조회 시 자동으로 덧씌운다.
//   따라서 여기서 snapshot writer 를 호출하지 않는다(계산·snapshot 무접촉 원칙).

const TABLE = "cluster4_line_enhancement_overrides";

const OVERRIDE_STATUSES: Cluster4EnhancementStatus[] = [
  "success",
  "fail",
  "pending",
  "not_applicable",
];
const PART_TYPES: Cluster4LinePartType[] = [
  "information",
  "experience",
  "competency",
  "career",
];

type FlatLine = {
  weekId: string;
  weekNumber: number;
  weekLabel: string;
  seasonKey: string | null;
  partType: Cluster4LinePartType;
  lineTargetId: string | null;
  lineId: string | null;
  lineCode: string | null;
  // placeholder(식별키 전무) 라인용 최후 폴백 키 — 카드 lines 배열 인덱스.
  ordinal: number;
  experienceSlotOrder: number | null;
  label: string;
  autoEnhancementStatus: Cluster4EnhancementStatus;
  autoEnhancementReason: string;
  // 모든 라인은 ordinal 로 키를 만들 수 있으므로 항상 수정 가능.
  canOverride: boolean;
};

function lineLabel(line: Cluster4WeeklyCardDto["lines"][number]): string {
  return (
    line.lineName ||
    line.activityTypeName ||
    line.displayLineCode ||
    line.mainTitle ||
    line.lineCode ||
    "(라인)"
  );
}

// raw(override 미적용) 카드에서 override 대상 라인을 평탄화한다.
//   ordinal = 카드 lines 배열 인덱스(placeholder 라인 키). 모든 라인이 키를 가질 수 있어 canOverride 항상 true.
function flattenAutoLines(cards: Cluster4WeeklyCardDto[]): FlatLine[] {
  const out: FlatLine[] = [];
  for (const card of cards ?? []) {
    const weekId = card.weekId;
    if (!weekId || !Array.isArray(card.lines)) continue;
    card.lines.forEach((line, ordinal) => {
      out.push({
        weekId,
        weekNumber: card.weekNumber,
        weekLabel: card.weekLabel,
        seasonKey: card.seasonKey ?? null,
        partType: line.partType,
        lineTargetId: line.lineTargetId ?? null,
        lineId: line.lineId ?? null,
        lineCode: line.lineCode ?? null,
        ordinal,
        experienceSlotOrder: line.experienceSlotOrder ?? null,
        label: lineLabel(line),
        autoEnhancementStatus: line.enhancementStatus,
        autoEnhancementReason: line.enhancementReason,
        canOverride: true,
      });
    });
  }
  return out;
}

async function loadRawCards(userId: string): Promise<Cluster4WeeklyCardDto[]> {
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status === "hit" || snap.status === "stale") return snap.cards;
  // miss/error: raw 계산·저장(override 는 여기 반영되지 않는다 — snapshot 은 raw).
  return await recomputeAndStoreWeeklyCardsSnapshot(userId);
}

// GET ?user_id=<uuid>
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const userId = request.nextUrl.searchParams.get("user_id");
  if (!userId) {
    return Response.json({ success: false, error: "user_id is required" }, { status: 400 });
  }

  try {
    await assertUserInRequestScope(request, userId);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const [rawCards, overrides] = await Promise.all([
      loadRawCards(userId),
      loadEnhancementOverridesForUser(userId),
    ]);
    return Response.json({
      success: true,
      data: { userId, lines: flattenAutoLines(rawCards), overrides },
    });
  } catch (error) {
    console.error("[enhancement-overrides GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load" },
      { status: 500 },
    );
  }
}

// POST — override upsert(자동 계산값 위에 수동 강화 상태 강제).
export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ success: false, error: "Request body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const userId = typeof b.user_id === "string" ? b.user_id : null;
  const weekId = typeof b.week_id === "string" ? b.week_id : null;
  const partType = typeof b.part_type === "string" ? (b.part_type as Cluster4LinePartType) : null;
  const overrideStatus =
    typeof b.override_status === "string"
      ? (b.override_status as Cluster4EnhancementStatus)
      : null;
  const lineTargetId = typeof b.line_target_id === "string" && b.line_target_id ? b.line_target_id : null;
  const lineId = typeof b.line_id === "string" && b.line_id ? b.line_id : null;
  const lineCode = typeof b.line_code === "string" && b.line_code ? b.line_code : null;
  // placeholder 라인 폴백 키(카드 lines 배열 인덱스). identity 가 있으면 무시(identity 우선).
  const lineOrdinal =
    typeof b.line_ordinal === "number" && Number.isInteger(b.line_ordinal) && b.line_ordinal >= 0
      ? b.line_ordinal
      : null;
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  const source = typeof b.source === "string" && b.source.trim() ? b.source.trim().slice(0, 100) : "admin_manual";

  if (!userId) return Response.json({ success: false, error: "user_id is required" }, { status: 400 });
  if (!weekId) return Response.json({ success: false, error: "week_id is required" }, { status: 400 });
  if (!partType || !PART_TYPES.includes(partType)) {
    return Response.json({ success: false, error: "part_type is invalid" }, { status: 400 });
  }
  if (!overrideStatus || !OVERRIDE_STATUSES.includes(overrideStatus)) {
    return Response.json({ success: false, error: "override_status is invalid" }, { status: 400 });
  }
  // identity 가 없으면 line_ordinal 로라도 라인을 특정할 수 있어야 한다(placeholder 라인 지원).
  const useOrdinal = !lineTargetId && !lineId && !lineCode;
  if (useOrdinal && lineOrdinal == null) {
    return Response.json(
      { success: false, error: "line_target_id/line_id/line_code/line_ordinal 중 하나는 필요합니다." },
      { status: 400 },
    );
  }
  // identity 가 있으면 ordinal 은 저장하지 않는다(identity 우선 매칭). 없으면 ordinal 로 저장.
  const storeOrdinal = useOrdinal ? lineOrdinal : null;

  try {
    await assertUserInRequestScope(request, userId, { bodyMode: b.mode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    // 동일 식별(user_id, week_id, part_type, target/line/code)의 기존 행을 찾아 update, 없으면 insert.
    //   (unique 인덱스가 COALESCE 표현식이라 upsert onConflict 대신 find-then-write 로 처리.)
    let findQ = supabaseAdmin
      .from(TABLE)
      .select("id")
      .eq("user_id", userId)
      .eq("week_id", weekId)
      .eq("part_type", partType);
    findQ = lineTargetId ? findQ.eq("line_target_id", lineTargetId) : findQ.is("line_target_id", null);
    findQ = lineId ? findQ.eq("line_id", lineId) : findQ.is("line_id", null);
    findQ = lineCode ? findQ.eq("line_code", lineCode) : findQ.is("line_code", null);
    findQ = storeOrdinal != null ? findQ.eq("line_ordinal", storeOrdinal) : findQ.is("line_ordinal", null);
    const { data: existing, error: findErr } = await findQ.maybeSingle();
    if (findErr) throw new Error(findErr.message);

    const nowIso = new Date().toISOString();
    if (existing?.id) {
      const { data, error } = await supabaseAdmin
        .from(TABLE)
        .update({
          override_status: overrideStatus,
          note,
          source,
          created_by: admin.userId,
          updated_at: nowIso,
        })
        .eq("id", existing.id)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return Response.json({ success: true, data: { override: data } }, { status: 200 });
    }

    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .insert({
        user_id: userId,
        week_id: weekId,
        part_type: partType,
        line_target_id: lineTargetId,
        line_id: lineId,
        line_code: lineCode,
        line_ordinal: storeOrdinal,
        override_status: overrideStatus,
        source,
        note,
        created_by: admin.userId,
      })
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return Response.json({ success: true, data: { override: data } }, { status: 200 });
  } catch (error) {
    console.error("[enhancement-overrides POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save override" },
      { status: 500 },
    );
  }
}

// DELETE ?id=<uuid> — override 해제(자동 계산값으로 복귀).
export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return Response.json({ success: false, error: "id is required" }, { status: 400 });
  }

  try {
    // 스코프 게이트: 삭제 대상 override 의 소유 user_id 가 요청 스코프 내인지 확인(fail-closed).
    const { data: row, error: readErr } = await supabaseAdmin
      .from(TABLE)
      .select("id,user_id")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) {
      return Response.json({ success: false, error: "override not found" }, { status: 404 });
    }
    try {
      await assertUserInRequestScope(request, row.user_id);
    } catch (error) {
      return Response.json(
        { success: false, error: error instanceof Error ? error.message : "Scope violation" },
        { status: (error as { status?: number }).status ?? 422 },
      );
    }

    const { error } = await supabaseAdmin.from(TABLE).delete().eq("id", id);
    if (error) throw new Error(error.message);
    return Response.json({ success: true, data: { id } }, { status: 200 });
  } catch (error) {
    console.error("[enhancement-overrides DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete override" },
      { status: 500 },
    );
  }
}
