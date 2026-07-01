// ─────────────────────────────────────────────────────────────────────
// @deprecated 2026-07-01: validates removed QA behavior (forceOperating split / W13 exception).
//   Kept for history.
//
//   이 스크립트는 폐지된 "read=운영노출 / select+write=test전용" 분리(forceOperating split)를
//   검증한다. 2026-07-01 정책 변경으로 QA_HIDE_REAL_USERS 는 population-only 단일 스위치가 되어
//   read·select·write 모집단이 항상 동일(테스트 전용)하다. "읽기만 실사용자 노출"이라는 전제는
//   더 이상 성립하지 않으므로 아래 [READ] 계약(실유저 노출)은 현행 모델과 어긋난다.
//   심볼 유효성(import) 만 유지하며, 로직은 이력 보존용으로 남겨둔다.
// ─────────────────────────────────────────────────────────────────────
/** @deprecated 검증: (구) QA_HIDE_REAL_USERS 유지하 read=운영노출 / select+write=test전용 (direct). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
import {
  listCluster4LinesDetailed, listCluster4InfoLinesDetailed, listCluster4LineTargets,
} from "@/lib/adminCluster4LinesData";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";
import { listCluster4Users } from "@/lib/adminCluster4UsersData";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { getCluster4LineDetailForProfileUser } from "@/lib/cluster4LinesData";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c?"✅":"❌"} ${m}`); c?pass++:fail++; };

(async () => {
  console.log(`QA_HIDE_REAL_USERS = ${QA_HIDE_REAL_USERS} (유지 전제)\n`);
  const testIds = await fetchTestUserMarkerIds();

  // 표본: 실유저 대상 experience 라인 (spring)
  const { data: sw } = await supabaseAdmin.from("weeks").select("id,week_number").eq("season_key","2026-spring");
  const springIds = (sw??[]).map((w:any)=>w.id);
  let sample: {uid:string;weekId:string;org:string;part:string;lineId:string}|null=null;
  for (const wid of springIds) {
    const { data } = await supabaseAdmin.from("cluster4_line_targets")
      .select("line_id,target_user_id,week_id,cluster4_lines!inner(part_type,is_active)")
      .eq("target_mode","user").eq("week_id",wid).eq("cluster4_lines.is_active",true);
    for (const r of (data??[]) as any[]) {
      if (!testIds.has(r.target_user_id)) {
        const { data:p } = await supabaseAdmin.from("user_profiles").select("organization_slug").eq("user_id",r.target_user_id).maybeSingle();
        sample={uid:r.target_user_id,weekId:r.week_id,org:(p as any)?.organization_slug,part:r.cluster4_lines.part_type,lineId:r.line_id}; break;
      }
    }
    if (sample) break;
  }
  if (!sample){console.log("표본 실유저 라인 없음");process.exit(1);}
  console.log(`표본: 실유저 org=${sample.org} part=${sample.part} lineId=${sample.lineId}\n`);

  // 1) 어드민 라인 목록 read → 운영 라인 노출(>0), 표본 라인 포함
  const list = await listCluster4LinesDetailed({ weekId: sample.weekId, partType: sample.part as any, organization: sample.org as any, mode: "operating" } as any);
  ok(list.rows.length>0, `[READ] 어드민 라인목록 rows=${list.rows.length} (운영 노출)`);
  ok(list.rows.some(r=>r.id===sample!.lineId), `[READ] 표본 운영 라인이 목록에 포함`);

  // 2) 라인 상세 targets read → 운영 대상자(실유저) 노출
  const tg = await listCluster4LineTargets(sample.lineId, "operating");
  ok(tg.rows.some(t=>t.targetUserId===sample!.uid), `[READ] 라인상세 대상자에 실유저 포함 (targets=${tg.rows.length})`);

  // 3) 주차별 개설결과 read → 운영 개설 라인 노출 (info 표본)
  //    info 운영 라인 있는 org/week 탐색
  let infoSample:{weekId:string;org:string}|null=null;
  for (const wid of springIds) {
    const { data } = await supabaseAdmin.from("cluster4_line_targets")
      .select("target_user_id,week_id,cluster4_lines!inner(part_type,is_active,line_code)")
      .eq("target_mode","user").eq("week_id",wid).eq("cluster4_lines.part_type","info").eq("cluster4_lines.is_active",true).limit(50);
    const real=(data??[]).find((r:any)=>!testIds.has(r.target_user_id)) as any;
    if(real){const code=real.cluster4_lines.line_code; const org=/EC/.test(code||"")?"encre":/OK/.test(code||"")?"oranke":/PX/.test(code||"")?"phalanx":null; if(org){infoSample={weekId:wid,org};break;}}
  }
  if(infoSample){
    const res = await getInfoLineResultsForWeek({ weekId: infoSample.weekId, organization: infoSample.org as any, mode: "operating" });
    ok(res.openedLineCount>0, `[READ] 주차별개설결과 openedLineCount=${res.openedLineCount} org=${infoSample.org} (운영 노출)`);
  } else console.log("  (info 운영 org 라인 표본 없음 — 주차결과 검증 스킵)");

  // 4) 크루 선택기 → test 전용 유지
  const users = await listCluster4Users({ organization: sample.org, mode: "operating" });
  ok(users.length>0 && users.every(u=>testIds.has(u.userId)), `[SELECT] /users 크루선택기 전원 test (n=${users.length})`);
  const crews = await listCrewsForTargetSelection({ organization: sample.org, mode: "operating" });
  ok(crews.every(c=>testIds.has(c.userId)), `[SELECT] /crews 선택기 전원 test (n=${crews.length})`);

  // 5) write 가드 → 실유저 422, test 통과
  const scope = await resolveUserScope("operating", sample.org as any);
  let blocked=false; try{ assertUserIdsInScope(scope,[sample.uid]); }catch(e:any){ blocked=e?.status===422; }
  ok(blocked, `[WRITE] 실유저 선택 시 422 차단`);
  const aTest=[...testIds][0]; let allowed=true; try{ assertUserIdsInScope(scope,[aTest]); }catch{ allowed=false; }
  ok(allowed, `[WRITE] 테스트유저 선택은 통과`);

  // 6) 고객앱 회귀 → 여전히 success
  const cust = await getCluster4LineDetailForProfileUser(sample.uid, sample.weekId, sample.part as any);
  ok(cust.status==="success" && !!cust.line, `[CUSTOMER] 고객 라인상세 status=${cust.status} (회귀 없음)`);

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail>0?1:0);
})().catch(e=>{console.error("FATAL",e);process.exit(1);});
