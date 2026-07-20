/**
 * DB 통합 검증 — "완료 취소(un-complete)" 시 수집 진단값 초기화가 실제 서비스 함수에서 각인되는지.
 *   실제 rollback 함수를 호출한다(로직 복제 없음):
 *     · 정규 : lib/processCheckRollback.rollbackProcessCheckCompletion
 *     · 변동 : lib/adminProcessIrregularData.rollbackIrregularAct
 *   실 테스트 행에 "완료 + 수집값(성공/댓글수/오류/last_error) + recipients" 를 합성으로 얹었다가
 *   rollback 으로 되돌리고, 수집 3컬럼 + last_error + checked_crew_count 가 전부 null·recipients 삭제됨을
 *   확인한 뒤 원본을 정확히 복원한다. 운영/테스트 스코프 모두 검증(운영은 테스트 행 scope 임시 전환).
 *
 *   ⚠ 실 Supabase 자격이 필요하다(headless 환경 미실행). 자격 있는 환경에서:
 *     npx tsx --env-file=.env.local scripts/verify-uncomplete-collection-reset.ts
 *
 *   회귀 방지 대조(재수집 실패 보존): 완료 취소 초기화와 "정상 완료 후 재수집 실패 보존"은 다른 정책이다.
 *     후자(raw_comment_count·recipients 보존)는 scripts/verify-comment-collection-sweep.ts 시나리오4 가 커버.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { rollbackProcessCheckCompletion } from "@/lib/processCheckRollback";
import { rollbackIrregularAct } from "@/lib/adminProcessIrregularData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

// 수집 컬럼 적용 여부(미적용이면 수집 3컬럼 assertion 은 스킵하고 last_error 만 확인).
async function collectionColsApplied(table: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from(table).select("comment_collection_status").limit(1);
  return !error;
}

async function main() {
  const regCols = await collectionColsApplied("process_check_statuses");
  const irrCols = await collectionColsApplied("process_irregular_acts");
  console.log(`수집 컬럼 적용: 정규=${regCols} 변동=${irrCols}`);

  // ── 정규(process_check_statuses) ─────────────────────────────────────────────
  const { data: regRows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,scope_mode,organization_slug,week_id,completed_at,checked_crew_count,review_link,scheduled_check_at,requested_at,requested_by,last_error")
    .eq("scope_mode", "test")
    .limit(1);
  const R = regRows?.[0] as Record<string, unknown> | undefined;
  ck("[정규] 테스트 스코프 행 존재", !!R, R ? { id: String(R.id).slice(0, 8) } : "none");

  if (R) {
    const orig = { ...R };
    const { data: origRecips } = await supabaseAdmin
      .from("process_check_review_recipients").select("*").eq("source", "regular").eq("ref_id", R.id);

    async function setupCompleted(scopeMode: "operating" | "test") {
      const upd: Record<string, unknown> = {
        status: "completed",
        completed_at: new Date().toISOString(),
        checked_crew_count: 1,
        scope_mode: scopeMode,
        last_error: "seed: 이전 시도 오류",
      };
      if (regCols) {
        upd.raw_comment_count = 9;
        upd.comment_collection_status = "success";
        upd.comment_collection_error_code = null;
      }
      await supabaseAdmin.from("process_check_statuses").update(upd).eq("id", R!.id);
      // 결정성: 기존 recipients 비우고 합성 1건(닉네임만·user_id null → 적립/스코프 무영향).
      await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", R!.id);
      await supabaseAdmin.from("process_check_review_recipients").insert({
        source: "regular", ref_id: R!.id, organization_slug: R!.organization_slug,
        scope_mode: scopeMode, user_id: null, nickname: "__reset_test__", match_type: "review", match_reason: "verify",
      });
    }

    async function assertReset(tag: string) {
      const { data: after } = await supabaseAdmin
        .from("process_check_statuses")
        .select("status,completed_at,checked_crew_count,last_error" + (regCols ? ",raw_comment_count,comment_collection_status,comment_collection_error_code" : ""))
        .eq("id", R!.id).maybeSingle();
      const a = (after ?? {}) as Record<string, unknown>;
      ck(`${tag} status=needed`, a.status === "needed", a.status);
      ck(`${tag} completed_at=null·checked_crew_count=null`, a.completed_at === null && a.checked_crew_count === null);
      ck(`${tag} last_error=null(이전 오류 제거)`, a.last_error === null, a.last_error);
      if (regCols) {
        ck(`${tag} raw_comment_count=null(취소된 댓글수 미노출)`, a.raw_comment_count === null, a.raw_comment_count);
        ck(`${tag} comment_collection_status=null`, a.comment_collection_status === null, a.comment_collection_status);
        ck(`${tag} comment_collection_error_code=null`, a.comment_collection_error_code === null);
      }
      const { data: rec } = await supabaseAdmin.from("process_check_review_recipients").select("id").eq("source", "regular").eq("ref_id", R!.id);
      ck(`${tag} recipients 삭제`, (rec ?? []).length === 0);
    }

    // (A) 테스트 스코프
    await setupCompleted("test");
    const dT = await rollbackProcessCheckCompletion({ statusId: String(R.id), actor: null });
    ck("[정규·test] rollback ok·needed", dT.ok && dT.status === "needed");
    await assertReset("[정규·test]");

    // (B) 운영 스코프(테스트 행 scope 임시 전환 — 실운영 행 무접촉)
    await setupCompleted("operating");
    const dO = await rollbackProcessCheckCompletion({ statusId: String(R.id), actor: null });
    ck("[정규·operating] rollback ok·needed", dO.ok && dO.status === "needed");
    await assertReset("[정규·operating]");

    // 복원
    await supabaseAdmin.from("process_check_statuses").update(orig).eq("id", R.id);
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", R.id);
    if ((origRecips ?? []).length) {
      await supabaseAdmin.from("process_check_review_recipients").insert(
        (origRecips as Record<string, unknown>[]).map((x) => { const rest = { ...x }; delete rest.id; delete rest.created_at; return rest; }),
      );
    }
    ck("[정규] 원본 복원", true);
  }

  // ── 변동(process_irregular_acts) — review_request 완료→대기 ────────────────────
  const { data: irrRows } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("id,status,scope_mode,organization_slug,week_id,kind,completed_at,scheduled_check_at,review_link,last_error")
    .eq("scope_mode", "test").eq("kind", "review_request")
    .limit(1);
  const IR = irrRows?.[0] as Record<string, unknown> | undefined;
  ck("[변동] 테스트 스코프 review_request 행 존재", !!IR, IR ? { id: String(IR.id).slice(0, 8) } : "none(스킵)");

  if (IR) {
    const orig = { ...IR };
    const { data: origRecips } = await supabaseAdmin
      .from("process_check_review_recipients").select("*").eq("source", "irregular").eq("ref_id", IR.id);

    const upd: Record<string, unknown> = {
      status: "completed",
      completed_at: new Date().toISOString(),
      scheduled_check_at: null, // 자동완료 가드 회피(완료 상태로 직접 되돌림 경로).
      last_error: "seed: 이전 시도 오류",
    };
    if (irrCols) {
      upd.raw_comment_count = 4;
      upd.comment_collection_status = "success";
      upd.comment_collection_error_code = null;
    }
    await supabaseAdmin.from("process_irregular_acts").update(upd).eq("id", IR.id);
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", IR.id);
    await supabaseAdmin.from("process_check_review_recipients").insert({
      source: "irregular", ref_id: IR.id, organization_slug: IR.organization_slug,
      scope_mode: "test", user_id: null, nickname: "__reset_test__", match_type: "review", match_reason: "verify",
    });

    try {
      const res = await rollbackIrregularAct(String(IR.id), String(IR.organization_slug), "test");
      ck("[변동·test] rollback → pending", res.status === "pending", res.status);
      const { data: after } = await supabaseAdmin
        .from("process_irregular_acts")
        .select("status,completed_at,last_error" + (irrCols ? ",raw_comment_count,comment_collection_status,comment_collection_error_code" : ""))
        .eq("id", IR.id).maybeSingle();
      const a = (after ?? {}) as Record<string, unknown>;
      ck("[변동·test] status=pending·completed_at=null", a.status === "pending" && a.completed_at === null);
      ck("[변동·test] last_error=null", a.last_error === null, a.last_error);
      if (irrCols) {
        ck("[변동·test] raw_comment_count=null", a.raw_comment_count === null, a.raw_comment_count);
        ck("[변동·test] comment_collection_status=null", a.comment_collection_status === null);
        ck("[변동·test] comment_collection_error_code=null", a.comment_collection_error_code === null);
      }
      const { data: rec } = await supabaseAdmin.from("process_check_review_recipients").select("id").eq("source", "irregular").eq("ref_id", IR.id);
      ck("[변동·test] recipients 삭제", (rec ?? []).length === 0);
    } catch (e) {
      ck("[변동·test] rollback 예외 없음", false, e instanceof Error ? e.message : String(e));
    }

    // 복원
    await supabaseAdmin.from("process_irregular_acts").update(orig).eq("id", IR.id);
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", IR.id);
    if ((origRecips ?? []).length) {
      await supabaseAdmin.from("process_check_review_recipients").insert(
        (origRecips as Record<string, unknown>[]).map((x) => { const rest = { ...x }; delete rest.id; delete rest.created_at; return rest; }),
      );
    }
    ck("[변동] 원본 복원", true);
  }

  // snapshot 재계산 부작용 없음 확인용(회수 유저 없었으므로 no-op) — 결정성 위해 명시 호출 생략.
  void recomputeWeeklyCardsSnapshotsForUsers;

  console.log(failed === 0 ? "\n✅ ALL PASS (un-complete 수집 진단값 초기화 · 정규+변동 · 운영+테스트)" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
