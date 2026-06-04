import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  EditWindowError,
  evaluateEditWindowPermission,
  getEditWindowForUser,
} from "@/lib/adminEditWindowsData";
import {
  REVIEW_LINK_RESOURCE_KEY,
  REVIEW_LINK_SLOTS,
  findReviewLinkOrderViolation,
  isReviewLinkWeekIndex,
  normalizeReviewLinkUrl,
  reviewLinkOrderErrorMessage,
  type ReviewLinkDto,
  type ReviewLinkWeekIndex,
} from "@/lib/reviewLinks";

type ReviewLinkRow = {
  week_index: number;
  url: string | null;
  is_visible: boolean | null;
};

async function getCurrentUserId(): Promise<string | null> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  return resolveProfileUserId(user.id, user.email);
}

async function isCurrentUserAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("id,is_active")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data && (data as { is_active: boolean | null }).is_active);
}

function buildLinks(
  rows: ReviewLinkRow[],
  legacyTotalComplete: string | null,
): ReviewLinkDto[] {
  const byWeek = new Map<number, ReviewLinkRow>();
  for (const row of rows) byWeek.set(row.week_index, row);

  return REVIEW_LINK_SLOTS.map((slot) => {
    const row = byWeek.get(slot.weekIndex);
    const legacyUrl =
      slot.weekIndex === 30 && legacyTotalComplete?.trim()
        ? legacyTotalComplete
        : null;
    return {
      ...slot,
      url: row?.url ?? legacyUrl,
      isVisible: row?.is_visible ?? true,
      isLegacyBackfilled: !row && Boolean(legacyUrl),
    };
  });
}

async function readReviewLinks(userId: string) {
  const [linksRes, legacyRes] = await Promise.all([
    supabaseAdmin
      .from("user_review_links")
      .select("week_index,url,is_visible")
      .eq("user_id", userId),
    supabaseAdmin
      .from("user_cluster2")
      .select("cluving_review_link")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (linksRes.error) throw new Error(linksRes.error.message);
  if (legacyRes.error) throw new Error(legacyRes.error.message);

  const legacyTotalComplete =
    ((legacyRes.data as { cluving_review_link: string | null } | null)
      ?.cluving_review_link as string | null) ?? null;
  const links = buildLinks(
    ((linksRes.data ?? []) as unknown) as ReviewLinkRow[],
    legacyTotalComplete,
  );

  return {
    links,
    cluvingReviewLink:
      links.find((link) => link.weekIndex === 30)?.url ?? null,
  };
}

function parsePayload(body: unknown): Map<ReviewLinkWeekIndex, string | null> {
  const out = new Map<ReviewLinkWeekIndex, string | null>();
  if (!body || typeof body !== "object") return out;
  const input = body as Record<string, unknown>;

  if (typeof input.cluvingReviewLink === "string" || input.cluvingReviewLink == null) {
    if ("cluvingReviewLink" in input) {
      out.set(30, normalizeReviewLinkUrl(input.cluvingReviewLink));
    }
  }

  const linksObject = input.links;
  if (linksObject && typeof linksObject === "object" && !Array.isArray(linksObject)) {
    for (const slot of REVIEW_LINK_SLOTS) {
      const byStorageKey = (linksObject as Record<string, unknown>)[slot.storageKey];
      const byWeek = (linksObject as Record<string, unknown>)[String(slot.weekIndex)];
      if (byStorageKey !== undefined) {
        out.set(slot.weekIndex, normalizeReviewLinkUrl(byStorageKey));
      } else if (byWeek !== undefined) {
        out.set(slot.weekIndex, normalizeReviewLinkUrl(byWeek));
      }
    }
  }

  const reviewLinks = input.reviewLinks;
  if (Array.isArray(reviewLinks)) {
    for (const item of reviewLinks) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const weekIndex = Number(record.weekIndex ?? record.week_index);
      if (!isReviewLinkWeekIndex(weekIndex)) continue;
      out.set(weekIndex, normalizeReviewLinkUrl(record.url));
    }
  }

  return out;
}

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return Response.json(
        { success: false, error: "Authentication required." },
        { status: 401 },
      );
    }

    const data = await readReviewLinks(userId);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[review-link GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load review links",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return Response.json(
        { success: false, error: "Authentication required." },
        { status: 401 },
      );
    }

    const isAdmin = await isCurrentUserAdmin(userId);
    const window = await getEditWindowForUser(userId, REVIEW_LINK_RESOURCE_KEY);
    const permission = evaluateEditWindowPermission(
      REVIEW_LINK_RESOURCE_KEY,
      window,
      { isAdmin },
    );
    if (!permission.canEdit) {
      return Response.json(
        { success: false, error: "Review link edit permission denied.", data: permission },
        { status: 403 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const updates = parsePayload(body);
    if (updates.size === 0) {
      return Response.json(
        { success: false, error: "No review links supplied" },
        { status: 400 },
      );
    }

    // ── 순차 작성 검증 (전사 공통 정책) ──
    // 클럽 리뷰는 3 → 6 → … → 27 → 30(Total Complete) 순서대로만 작성/삭제할 수 있다.
    // "이번 요청에서 변경되는 슬롯"만 검사한다(레거시로 순서가 깨진 데이터가 있어도
    // 무관한 슬롯 저장은 막지 않음). front repo PUT /api/review-link 와 동일 규칙.
    {
      const { data: existingRows, error: existingError } = await supabaseAdmin
        .from("user_review_links")
        .select("week_index,url")
        .eq("user_id", userId);
      if (existingError) throw new Error(existingError.message);
      const existingByWeek = new Map<number, string | null>();
      for (const row of (existingRows ?? []) as Array<{ week_index: number; url: string | null }>) {
        existingByWeek.set(row.week_index, normalizeReviewLinkUrl(row.url));
      }
      const violation = findReviewLinkOrderViolation(existingByWeek, updates);
      if (violation) {
        return Response.json(
          { success: false, error: reviewLinkOrderErrorMessage(violation), data: violation },
          { status: 400 },
        );
      }
    }

    const rows = Array.from(updates.entries()).map(([weekIndex, url]) => ({
      user_id: userId,
      week_index: weekIndex,
      url,
      is_visible: true,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertError } = await supabaseAdmin
      .from("user_review_links")
      .upsert(rows, { onConflict: "user_id,week_index" });
    if (upsertError) throw new Error(upsertError.message);

    if (updates.has(30)) {
      const { error: legacyError } = await supabaseAdmin
        .from("user_cluster2")
        .upsert(
          {
            user_id: userId,
            cluving_review_link: updates.get(30) ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
      if (legacyError) throw new Error(legacyError.message);
    }

    const data = await readReviewLinks(userId);
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[review-link PUT]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to save review links",
      },
      { status: 500 },
    );
  }
}
