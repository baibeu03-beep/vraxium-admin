/**
 * activityCompletion·successWeeks(메달) 정합성: SLIM(cluster4_roster_card_stats)
 *  vs 현재 snapshot 카드에서 직접 파생(deriveRosterCardStats) — 고객 weekly-cards 와 동일 SoT.
 * + dto_version/staleness 로 인한 admin(slim)↔customer(live recompute) 잠재 divergence 카운트.
 * READ-ONLY.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { deriveRosterCardStats, rosterActivityRate } from "@/lib/rosterCardStats";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

function todayIsoKst(){
  // KST 기준 yyyy-mm-dd (snapshot 파생과 동일 축). 환경 TZ 무관하게 +9h.
  const d = new Date(Date.now()+9*3600*1000);
  return d.toISOString().slice(0,10);
}
async function fetchAll(t:string,c:string){const o:any[]=[];let f=0;const p=500;for(;;){const{data,error}=await supabaseAdmin.from(t).select(c).order("user_id",{ascending:true}).range(f,f+p-1);if(error)throw new Error(t+":"+error.message);const b=(data??[])as any[];o.push(...b);if(b.length<p)break;f+=p;}return o;}

async function main(){
  const today = todayIsoKst();
  const slimRows = await fetchAll("cluster4_roster_card_stats","user_id,success_weeks,activity_available,activity_completed,dto_version,snapshot_computed_at");
  const slim = new Map(slimRows.map(r=>[r.user_id,r]));
  const snaps = await fetchAll("cluster4_weekly_card_snapshots","user_id,cards,dto_version,is_stale,computed_at");

  let n=0, actMatch=0, actMismatch=0, swMatch=0, swMismatch=0, deriveNull=0, noSlim=0;
  let maxActDiff=0, maxSwDiff=0;
  const actMis:any[]=[]; const swMis:any[]=[];
  let verDrift=0, staleFlag=0;

  for (const sn of snaps){
    const cards = sn.cards;
    if (!Array.isArray(cards)) continue;
    const derived = deriveRosterCardStats(cards as any, today);
    const S = slim.get(sn.user_id);
    if (sn.dto_version!==WEEKLY_CARDS_DTO_VERSION) verDrift++;
    if (sn.is_stale) staleFlag++;
    if (!derived){ deriveNull++; continue; }
    if (!S){ noSlim++; continue; }
    n++;
    const dAct = rosterActivityRate(derived.activityAvailable, derived.activityCompleted);
    const sAct = rosterActivityRate(S.activity_available, S.activity_completed);
    if (dAct===sAct) actMatch++; else { actMismatch++; maxActDiff=Math.max(maxActDiff,Math.abs(dAct-sAct)); actMis.push({u:sn.user_id, slim:sAct, snapshot:dAct, slim_avail:S.activity_available, snap_avail:derived.activityAvailable, ver:sn.dto_version, stale:sn.is_stale}); }
    if (derived.successWeeks===S.success_weeks) swMatch++; else { swMismatch++; maxSwDiff=Math.max(maxSwDiff,Math.abs(derived.successWeeks-S.success_weeks)); swMis.push({u:sn.user_id, slim_sw:S.success_weeks, snap_sw:derived.successWeeks, ver:sn.dto_version, stale:sn.is_stale}); }
  }
  console.log("\n════════ activity / successWeeks(메달): SLIM vs snapshot 파생 ════════");
  console.table([{ "비교 유저":n, "활동완료율 일치":actMatch, "활동완료율 불일치":actMismatch, "최대 % 차":maxActDiff, "성공주차 일치":swMatch, "성공주차 불일치":swMismatch, "최대 주차 차":maxSwDiff }]);
  console.log("staleness:", { code:WEEKLY_CARDS_DTO_VERSION, "snapshot ver!=code":verDrift, "is_stale=true":staleFlag, "deriveNull(비정상카드)":deriveNull, "slim 없음":noSlim, "snapshot rows":snaps.length });
  if(actMis.length){console.log("\n──활동완료율 불일치──");console.table(actMis.slice(0,40));}
  if(swMis.length){console.log("\n──성공주차 불일치──");console.table(swMis.slice(0,40));}
  console.log("\n[done]");
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
