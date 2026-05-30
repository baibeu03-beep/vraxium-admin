/**
 * 2026-05-30_cluster4_line_submissions_common_fields 적용 여부 검증 (PostgREST only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-submission-fields.ts
 *
 * exec_sql RPC / 직접 DB 연결이 없으므로 DDL 은 Supabase SQL Editor 에서 실행한다.
 * 이 스크립트는 service role(PostgREST)로 적용 결과를 검증한다:
 *   1. growth_point 컬럼 존재  2. output_images 컬럼 존재
 *   3. (ADD ... NOT NULL DEFAULT '[]' → 기존 row 가 [] 로 채워졌는지)
 *   4. 기존 row 수 영향  5. 제출 컬럼 select 시 컬럼 부재 에러 없음
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log("════════ cluster4_line_submissions 공통 제출 컬럼 검증 ════════\n");

  // 1·2·5. 신규 컬럼 select → 컬럼 부재 시 PostgREST 가 42703 에러 반환.
  const probe = await supabase
    .from("cluster4_line_submissions")
    .select("id,subtitle,growth_point,output_images,output_links")
    .limit(5);

  if (probe.error) {
    const missing =
      /column .* does not exist/i.test(probe.error.message) ||
      probe.error.code === "42703";
    console.log(`[1·2·5] ❌ 신규 컬럼 select 실패: ${probe.error.message}`);
    if (missing) {
      console.log("        → 아직 마이그레이션 미적용. 아래 SQL 을 Supabase SQL Editor 에서 실행하세요.\n");
    }
    process.exit(1);
  }
  console.log("[1] growth_point 컬럼 존재     ✅");
  console.log("[2] output_images 컬럼 존재    ✅");
  console.log("[5] 제출 컬럼 select 정상 (제출 API 컬럼 부재 에러 없음) ✅\n");

  // 4. 전체 row 수.
  const { count } = await supabase
    .from("cluster4_line_submissions")
    .select("*", { count: "exact", head: true });
  console.log(`[4] cluster4_line_submissions row 수: ${count ?? "?"}`);

  // 3. 기존 row 의 기본값 상태 (NOT NULL DEFAULT '[]' 는 기존 row 를 [] 로 채움).
  const rows = (probe.data ?? []) as Array<{
    id: string;
    growth_point: string | null;
    output_images: unknown;
  }>;
  if (rows.length === 0) {
    console.log("[3] 기존 row 0건 — 샘플 없음 (default 는 information_schema 로 확인 권장)\n");
  } else {
    let growthNull = 0;
    let imagesEmpty = 0;
    for (const r of rows) {
      if (r.growth_point === null) growthNull++;
      if (Array.isArray(r.output_images) && r.output_images.length === 0) imagesEmpty++;
    }
    console.log(
      `[3] 샘플 ${rows.length}건: growth_point NULL ${growthNull}/${rows.length}, ` +
        `output_images [] ${imagesEmpty}/${rows.length} ` +
        `${growthNull === rows.length && imagesEmpty === rows.length ? "(기존 row 영향 없음 ✅)" : "(확인 필요)"}`,
    );
  }

  console.log("\n════════ 검증 통과 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
