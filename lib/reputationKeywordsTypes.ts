// Browser-safe types for reputation_keywords (5군락 taxonomy).
// Client components may import from here, so keep server-only modules out
// (no supabaseAdmin, no next/headers).
//
// Canonical schema (peer-review pivot, 2026-05-21):
//
//   reputation_keywords
//     id              uuid         PK
//     cluster_number  integer      NOT NULL (1..5)
//     cluster_name    text         NOT NULL
//     cluster_color   text         NOT NULL
//     keyword         text         NOT NULL UNIQUE (1..30 chars)
//     created_at      timestamptz  NOT NULL DEFAULT now()
//
// 정책:
//   - keyword 는 자유 텍스트 (history row 의 keyword 컬럼은 FK 아님).
//   - admin 은 본 단계에서 read 전용. mutate 는 별도 PR.

export type ReputationKeywordRow = {
  id: string;
  cluster_number: number;
  cluster_name: string;
  cluster_color: string;
  keyword: string;
  created_at: string | null;
};

export type ReputationKeywordsListOptions = {
  // 단일 cluster 필터 (1..5). null/undefined => 필터 없음.
  clusterNumber?: number | null;
};

export type ReputationKeywordsListResult = {
  rows: ReputationKeywordRow[];
  available: boolean;
};
