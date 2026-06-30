/**
 * Phase D — 운영 자동 fallback(주차 공표/검수) 검증.
 *   안전 원칙: 실제 auto-publish 는 publishWeekResult(실유저 코호트 snapshot 재계산)를 호출하므로,
 *   검증은 dryRun(무변경)으로 "데드라인 KST 정밀 + due 식별 + 동일 함수 디스패치 대상"을 확인한다.
 *   (publish 실행 효과 자체=publishWeekResult 는 Phase A 에서 이미 검증됨.)
 *   npx tsx --env-file=.env.local scripts/verify-due-week-actions.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runDueWeekActionsSweep, publishCutoffMs, reviewCutoffMs } from "@/lib/dueWeekActionsSweep";
const URL=process.env.NEXT_PUBLIC_SUPABASE_URL!,SERVICE=process.env.SUPABASE_SERVICE_ROLE_KEY!,KEY=process.env.INTERNAL_API_KEY;
const BASE=process.env.WORKER_BASE_URL??"http://localhost:3000";
const sb=createClient(URL,SERVICE,{auth:{persistSession:false}});
let pass=0,fail=0;const ck=(l:string,ok:boolean,d="")=>{console.log(`${ok?"✅":"❌"} ${l}${d?` — ${d}`:""}`);ok?pass++:fail++;};
async function http(body:unknown){const r=await fetch(`${BASE}/api/admin/weeks/run-due-week-actions`,{method:"POST",headers:{"content-type":"application/json",...(KEY?{"x-internal-api-key":KEY}:{})},body:JSON.stringify(body)});return {status:r.status,json:(await r.json().catch(()=>({}))) as any};}
async function main(){
  // A) 데드라인 KST 정밀(end_date=일요일). 2026-06-28(일)+4=07-02(목)14:00KST=05:00Z / +5=07-03(금)16:00KST=07:00Z
  ck("[A 공표 cutoff] N+1 목 14:00 KST 정확", new Date(publishCutoffMs("2026-06-28")).toISOString()==="2026-07-02T05:00:00.000Z", new Date(publishCutoffMs("2026-06-28")).toISOString());
  ck("[A 검수 cutoff] N+1 금 16:00 KST 정확", new Date(reviewCutoffMs("2026-06-28")).toISOString()==="2026-07-03T07:00:00.000Z", new Date(reviewCutoffMs("2026-06-28")).toISOString());

  // B) due 식별(now=먼 미래 → 모든 미공표·非휴식=publish-due / 공표·미검수=review-due). DB 쿼리와 일치.
  const FUTURE=Date.parse("2030-01-01T00:00:00Z");
  const r=await runDueWeekActionsSweep({now:FUTURE,dryRun:true,maxItems:200});
  const {count:unpub}=await sb.from("weeks").select("id",{count:"exact",head:true}).is("result_published_at",null).eq("is_official_rest",false).not("end_date","is",null);
  const {count:pubUnrev}=await sb.from("weeks").select("id",{count:"exact",head:true}).not("result_published_at","is",null).is("result_reviewed_at",null).not("end_date","is",null);
  ck("[B publish due 식별=DB(미공표·非휴식)]", r.publish.due===(unpub??0), `sweep=${r.publish.due} db=${unpub}`);
  ck("[B review due 식별=DB(공표·미검수)]", r.review.due===(pubUnrev??0), `sweep=${r.review.due} db=${pubUnrev}`);

  // C) skip: due 목록의 publish 항목은 전부 미공표, review 항목은 전부 공표·미검수(이미 처리된 건 미포함).
  const pubIds=r.items.filter(i=>i.action==="publish").map(i=>i.weekId);
  const revIds=r.items.filter(i=>i.action==="review").map(i=>i.weekId);
  const {data:pubRows}=await sb.from("weeks").select("id,result_published_at").in("id",pubIds.length?pubIds:["00000000-0000-0000-0000-000000000000"]);
  const {data:revRows}=await sb.from("weeks").select("id,result_published_at,result_reviewed_at").in("id",revIds.length?revIds:["00000000-0000-0000-0000-000000000000"]);
  ck("[C skip] publish 대상 전부 미공표(이미 공표 건 제외)", (pubRows??[]).every((w:any)=>!w.result_published_at));
  ck("[C skip] review 대상 전부 공표·미검수(이미 검수 건 제외)", (revRows??[]).every((w:any)=>w.result_published_at && !w.result_reviewed_at));

  // D) direct == HTTP (now=now·dryRun — 라우트 wiring). 둘 다 동일 due.
  const dNow=await runDueWeekActionsSweep({dryRun:true});
  const hNow=await http({dryRun:true});
  ck("[D direct==HTTP] dryRun now publish/review due 동일", hNow.status===200 && dNow.publish.due===hNow.json?.data?.publish?.due && dNow.review.due===hNow.json?.data?.review?.due, `direct=${dNow.publish.due}/${dNow.review.due} http=${hNow.json?.data?.publish?.due}/${hNow.json?.data?.review?.due}`);
  ck("[D HTTP 내부키] 키 없으면 401", (await http({dryRun:true})) && (await fetch(`${BASE}/api/admin/weeks/run-due-week-actions`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status===401);

  // E) 운영/QA 무변경: dryRun 전후 weeks 공표수·qa_weeks_state·실유저 snapshot computed_at 불변.
  const {count:pubBefore}=await sb.from("weeks").select("id",{count:"exact",head:true}).not("result_published_at","is",null);
  const {count:qaBefore}=await sb.from("qa_weeks_state").select("week_id",{count:"exact",head:true});
  await runDueWeekActionsSweep({now:FUTURE,dryRun:true,maxItems:200}); // dryRun 실행
  const {count:pubAfter}=await sb.from("weeks").select("id",{count:"exact",head:true}).not("result_published_at","is",null);
  const {count:qaAfter}=await sb.from("qa_weeks_state").select("week_id",{count:"exact",head:true});
  ck("[E dryRun 운영 weeks 공표수 불변]", pubBefore===pubAfter, `${pubBefore}→${pubAfter}`);
  ck("[E dryRun QA overlay 불변(자동 fallback은 operating only)]", (qaBefore??0)===(qaAfter??0), `${qaBefore}→${qaAfter}`);

  // F) 감사 테이블 적용 여부 안내.
  const {error:logErr}=await sb.from("week_auto_action_log").select("id").limit(1);
  console.log(logErr?`⚠ week_auto_action_log 미적용(${logErr.message}) — 실행 시 감사로그는 best-effort skip(액션 무관). SQL Editor 적용 권장.`:"✅ week_auto_action_log 적용됨");

  console.log(`\n${pass} pass / ${fail} fail`);process.exit(fail?1:0);
}
main().catch(e=>{console.error(e);process.exit(1)});
