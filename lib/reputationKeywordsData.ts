// Server-only data layer for reputation_keywords master (peer-review pivot).
//
// Both /api/reputation-keywords (route handler) and the admin Cluster4 bundle
// (lib/adminCluster4Data.ts) reuse this — admin 경로는 HTTP roundtrip 없이
// 같은 함수를 직접 호출한다.
//
// 본 단계는 read 전용. cluster_number/keyword 정렬로 안정적 노출.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  ReputationKeywordRow,
  ReputationKeywordsListOptions,
  ReputationKeywordsListResult,
} from "@/lib/reputationKeywordsTypes";

const SELECT_COLUMNS =
  "id,cluster_number,cluster_name,cluster_color,keyword,created_at";

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return (
    typeof error.message === "string" && /does not exist/i.test(error.message)
  );
}

function normalizeRow(raw: Record<string, unknown>): ReputationKeywordRow {
  return {
    id: String(raw.id ?? ""),
    cluster_number:
      typeof raw.cluster_number === "number"
        ? raw.cluster_number
        : Number(raw.cluster_number ?? 0),
    cluster_name: String(raw.cluster_name ?? ""),
    cluster_color: String(raw.cluster_color ?? ""),
    keyword: String(raw.keyword ?? ""),
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
  };
}

export async function listReputationKeywords(
  options: ReputationKeywordsListOptions = {},
): Promise<ReputationKeywordsListResult> {
  let query = supabaseAdmin
    .from("reputation_keywords")
    .select(SELECT_COLUMNS)
    .order("cluster_number", { ascending: true })
    .order("keyword", { ascending: true });

  if (
    options.clusterNumber !== null &&
    options.clusterNumber !== undefined
  ) {
    query = query.eq("cluster_number", options.clusterNumber);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        '[reputation_keywords] table not found; returning empty result.',
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[reputation_keywords] query failed", {
      message: error.message,
    });
    throw new Error(error.message);
  }

  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeRow);
  return { rows, available: true };
}
