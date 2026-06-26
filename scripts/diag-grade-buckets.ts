import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
async function fetchAll(t:string,c:string){const o:any[]=[];let f=0;const p=1000;for(;;){const{data,error}=await supabaseAdmin.from(t).select(c).order("user_id",{ascending:true}).range(f,f+p-1);if(error)throw new Error(t+":"+error.message);const b=(data??[])as any[];o.push(...b);if(b.length<p)break;f+=p;}return o;}
function norm(s:string|null){return (s??"").replace(/\s+/g,"");}
async function main(){
  const uwp=await fetchAll("user_weekly_points","user_id");
  const ids=[...new Set(uwp.map(r=>r.user_id))];
  const cacheRows=await fetchAll("user_grade_stats","user_id,grade,grade_label,updated_at");
  const cache=new Map(cacheRows.map(r=>[r.user_id,r]));
  const live=await getClubRankGradeBatch(ids);
  let n=0,exact=0,labelOnly=0,gradeNum=0,cacheMiss=0;
  let maxNumDiff=0; const numMismatches:any[]=[];
  for(const u of ids){
    const L=live.get(u); if(!L)continue; n++;
    const C=cache.get(u);
    if(!C){cacheMiss++; continue;}
    const sameNum=C.grade===L.grade;
    const sameLabelExact=C.grade_label===L.label;
    const sameLabelNorm=norm(C.grade_label)===norm(L.label);
    if(sameNum&&sameLabelExact)exact++;
    else if(sameNum&&sameLabelNorm)labelOnly++;        // 공백만 차이
    else {gradeNum++; const d=Math.abs(L.grade-C.grade); maxNumDiff=Math.max(maxNumDiff,d);
      numMismatches.push({u,liveGrade:L.grade,cacheGrade:C.grade,diff:L.grade-C.grade,liveLabel:L.label,cacheLabel:C.grade_label,upd:(C.updated_at??"").slice(0,10)});}
  }
  console.log("\n════════ 품계 버킷 분해 ════════");
  console.table([{ "live 산출":n, "완전일치":exact, "공백만차이(라벨)":labelOnly, "품계숫자 불일치(stale)":gradeNum, "cache 결손":cacheMiss, "최대 품계숫자차":maxNumDiff }]);
  console.log("\n──── 품계 숫자 실제 불일치(cache stale) ────");
  if(numMismatches.length===0)console.log("  (없음)");
  else console.table(numMismatches.slice(0,80));
  console.log("\n[done] 숫자불일치="+gradeNum);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
