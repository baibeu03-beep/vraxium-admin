/**
 * (READ-ONLY 진단) 변동 액트 "체크 신청" SoT — 유형별 축 규명.
 *   축1 kind         : review_request(링크 신청) | manual_grant(수동 부여)  ← 라이프사이클/신청 축
 *   축2 crew_reaction: all(전원) | partial(부분)                            ← 포인트 부여 범위 축
 *   축3 status       : pending | completed                                  ← 검수 상태
 * 질문: '전원' 유형에 "대상자 개별 체크 신청" 기록이 실재하는가? (recipients 연결 키 확인)
 *
 *   npx tsx --env-file=.env.local scripts/diag-irregular-application-sot.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function line(s = "") {
  console.log(s);
}

async function main() {
  const cols =
    "id,week_id,kind,crew_reaction,status,review_link,scheduled_check_at,completed_at,target_user_id,point_a,point_b,point_c,organization_slug,scope_mode,created_at";
  let rows: Array<Record<string, unknown>> = [];
  let res = await supabaseAdmin.from("process_irregular_acts").select(cols + ",origin");
  if (res.error && (res.error as { code?: string }).code === "42703") {
    res = await supabaseAdmin.from("process_irregular_acts").select(cols);
  }
  if (res.error) {
    line(`✗ ${res.error.message}`);
    return;
  }
  rows = (res.data ?? []) as Array<Record<string, unknown>>;
  line(`═══ 변동 액트 ${rows.length}행 — kind × crew_reaction × status ═══`);
  const t = new Map<string, number>();
  for (const r of rows) {
    const k = `kind=${String(r.kind).padEnd(14)} | reaction=${String(r.crew_reaction).padEnd(8)} | status=${String(r.status).padEnd(9)} | target_user=${r.target_user_id ? "Y" : "N"} | origin=${(r as { origin?: string | null }).origin ?? "-"}`;
    t.set(k, (t.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...t.entries()].sort()) line(`   ${String(n).padStart(3)}×  ${k}`);

  // '전원(all)' 행에 recipients(대상자 식별 결과)가 붙어 있는가?
  line();
  line("═══ '전원(all)' 행의 recipients(대상자) 연결 ═══");
  const allRows = rows.filter((r) => r.crew_reaction === "all");
  line(`  전원(all) 행: ${allRows.length}`);
  const ids = allRows.map((r) => String(r.id));
  if (ids.length) {
    const { data: recs } = await supabaseAdmin
      .from("process_check_review_recipients")
      .select("ref_id,user_id,match_type")
      .eq("source", "irregular")
      .in("ref_id", ids);
    const byRef = new Map<string, { matched: number; review: number }>();
    for (const r of (recs ?? []) as Array<{ ref_id: string; match_type: string }>) {
      const e = byRef.get(r.ref_id) ?? { matched: 0, review: 0 };
      if (r.match_type === "matched") e.matched++;
      else e.review++;
      byRef.set(r.ref_id, e);
    }
    for (const r of allRows) {
      const e = byRef.get(String(r.id)) ?? { matched: 0, review: 0 };
      line(
        `   ${String(r.id).slice(0, 8)}  kind=${String(r.kind).padEnd(14)} status=${String(r.status).padEnd(9)} A/B/C=${r.point_a}/${r.point_b}/${r.point_c}  recipients[matched=${e.matched} review=${e.review}]`,
      );
    }
  }

  // 변동 액트가 process_check_statuses(정규 신청 테이블)와 연결되는가?
  line();
  line("═══ 변동 액트 ↔ process_check_statuses 연결 여부 ═══");
  const { data: st } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,act_id")
    .limit(1000);
  const stActIds = new Set(((st ?? []) as Array<{ act_id: string | null }>).map((r) => r.act_id));
  const irrIds = new Set(rows.map((r) => String(r.id)));
  const overlap = [...irrIds].filter((i) => stActIds.has(i));
  line(`  process_check_statuses.act_id 가 변동 액트 id 를 가리키는 행: ${overlap.length}`);
  line(`  ▶ 0 이면 변동 액트는 정규 신청 테이블과 무관 = 별도 "대상자 체크 신청" 기록 없음`);

  line();
  line("완료(read-only).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
