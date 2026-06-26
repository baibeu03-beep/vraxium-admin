/**
 * 품계(clubRank/grade) 전수: LIVE(getClubRankGradeBatch, 어드민 로스터·club-rank 라우트)
 *   vs CACHE(user_grade_stats, 고객 /api/profile 직독) 정합성. READ-ONLY.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";

async function fetchAll(table:string,cols:string){const out:any[]=[];let from=0;const page=1000;for(;;){const{data,error}=await supabaseAdmin.from(table).select(cols).order("user_id",{ascending:true}).range(from,from+page-1);if(error)throw new Error(table+":"+error.message);const b=(data??[])as any[];out.push(...b);if(b.length<page)break;from+=page;}return out;}

async function main(){
  // 대상 = point행 보유 유저(표시 대상)
  const uwp = await fetchAll("user_weekly_points","user_id");
  const userIds = [...new Set(uwp.map(r=>r.user_id))];
  console.log("대상 유저:", userIds.length);

  const cacheRows = await fetchAll("user_grade_stats","user_id,grade,grade_label,avg_percentile,updated_at");
  const cache = new Map(cacheRows.map(r=>[r.user_id,r]));

  const live = await getClubRankGradeBatch(userIds);

  let n=0, match=0, mismatch=0, liveNull=0, cacheMiss=0;
  let maxGradeDiff=0;
  const mismatches:any[]=[];
  for (const u of userIds){
    const L = live.get(u) ?? null;
    if (!L){ liveNull++; }
    const C = cache.get(u) ?? null;
    if (!C){ cacheMiss++; }
    if (!L) continue; // live가 null이면(시즌휴식 등) 표시대상 아님
    n++;
    const liveGrade=L.grade, liveLabel=L.label;
    const cacheGrade=C?.grade ?? null, cacheLabel=C?.grade_label ?? null;
    if (cacheGrade===liveGrade && cacheLabel===liveLabel) match++;
    else {
      mismatch++;
      if (cacheGrade!=null) maxGradeDiff=Math.max(maxGradeDiff,Math.abs(liveGrade-cacheGrade));
      mismatches.push({u, liveGrade, cacheGrade, liveLabel, cacheLabel, cache_pct:C?.avg_percentile??null, cache_upd:(C?.updated_at??"").slice(0,10)});
    }
  }
  console.log("\n════════ 품계 LIVE vs CACHE census ════════");
  console.table([{ "live 산출가능": n, "일치": match, "불일치": mismatch, "cache 결손": cacheMiss, "live=null(휴식등)": liveNull, "최대 품계차": maxGradeDiff }]);
  console.log("\n──── 불일치 상세(최대 80) ────");
  if(mismatches.length===0)console.log("  (없음)");
  else console.table(mismatches.slice(0,80));
  console.log("\n[done]");
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
