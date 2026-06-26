/**
 * po.A/B/C 별·방패·번개 전수 SoT 정합성 census (READ-ONLY).
 *   npx tsx --env-file=.env.local scripts/diag-poabc-census.ts
 * 비교 SoT:
 *   LIVE  = Σ user_weekly_points(points/advantages/penalty)  [resume card·po.A 라이브폴백·고객 resume]
 *   SLIM  = cluster4_roster_card_stats(po_a/po_b/po_c)        [/admin/members 로스터]
 *   CUM   = user_cumulative_points(total_checks/total_raw_advantages/total_penalties) [materialized 캐시]
 * 표시 정책: 별=Σpoints, 방패(net)=Σadv-Σpen, 번개=-Σpen
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

type Agg = { p: number; a: number; pen: number; rows: number };

async function liveSums(): Promise<Map<string, Agg>> {
  const m = new Map<string, Agg>();
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,points,advantages,penalty")
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error("uwp: " + error.message);
    const batch = (data ?? []) as any[];
    for (const r of batch) {
      const cur = m.get(r.user_id) ?? { p: 0, a: 0, pen: 0, rows: 0 };
      cur.p += r.points ?? 0; cur.a += r.advantages ?? 0; cur.pen += r.penalty ?? 0; cur.rows++;
      m.set(r.user_id, cur);
    }
    if (batch.length < page) break;
    from += page;
  }
  return m;
}

async function fetchAll(table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  const page = 1000; let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(cols).order("user_id",{ascending:true}).range(from, from+page-1);
    if (error) throw new Error(table+": "+error.message);
    const b = (data ?? []) as any[]; out.push(...b);
    if (b.length < page) break; from += page;
  }
  return out;
}

async function main(){
  console.log("WEEKLY_CARDS_DTO_VERSION(code) =", WEEKLY_CARDS_DTO_VERSION);
  const live = await liveSums();
  const slimRows = await fetchAll("cluster4_roster_card_stats","user_id,po_a,po_b,po_c,dto_version,snapshot_computed_at");
  const cumRows = await fetchAll("user_cumulative_points","user_id,total_checks,total_raw_advantages,total_penalties,updated_at");
  const slim = new Map(slimRows.map(r=>[r.user_id,r]));
  const cum = new Map(cumRows.map(r=>[r.user_id,r]));

  // snapshot dto_version drift
  const snapRows = await fetchAll("cluster4_weekly_card_snapshots","user_id,dto_version,is_stale,computed_at");
  const snap = new Map(snapRows.map(r=>[r.user_id,r]));

  const allUsers = new Set<string>([...live.keys(), ...slim.keys(), ...cum.keys()]);

  // net display helper
  const net = (a:number,pen:number)=>a-pen;

  let nUsers=0, slimMatch=0, slimMiss=0, slimMismatch=0, cumMatch=0, cumMiss=0, cumMismatch=0;
  let maxSlimStar=0, maxCumStar=0;
  const slimMismatches:any[]=[]; const cumMismatches:any[]=[];
  let slimVerStale=0, snapVerStale=0, snapStaleFlag=0;

  for (const u of allUsers){
    const L = live.get(u);
    if (!L) continue; // only users with point rows are display-relevant
    nUsers++;
    const liveStar=L.p, liveShield=net(L.a,L.pen), liveLight=-L.pen;

    // SLIM compare (po_a=star, po_b=advantages raw, po_c=penalty raw)
    const S = slim.get(u);
    if (!S){ slimMiss++; }
    else {
      const slimStar=S.po_a??0, slimShield=net(S.po_b??0,S.po_c??0), slimLight=-(S.po_c??0);
      const dStar=slimStar-liveStar, dShield=slimShield-liveShield, dLight=slimLight-liveLight;
      if (dStar===0&&dShield===0&&dLight===0) slimMatch++;
      else { slimMismatch++; maxSlimStar=Math.max(maxSlimStar,Math.abs(dStar));
        slimMismatches.push({u, liveStar, slimStar, dStar, liveShield, slimShield, dShield, liveLight, slimLight, dLight, slim_ver:S.dto_version}); }
      if (S.dto_version!==WEEKLY_CARDS_DTO_VERSION) slimVerStale++;
    }

    // CUM compare
    const C = cum.get(u);
    if (!C){ cumMiss++; }
    else {
      const cumStar=C.total_checks??0, cumShield=net(C.total_raw_advantages??0,C.total_penalties??0), cumLight=-(C.total_penalties??0);
      const dStar=cumStar-liveStar, dShield=cumShield-liveShield, dLight=cumLight-liveLight;
      if (dStar===0&&dShield===0&&dLight===0) cumMatch++;
      else { cumMismatch++; maxCumStar=Math.max(maxCumStar,Math.abs(dStar));
        cumMismatches.push({u, liveStar, cumStar, dStar, liveShield, cumShield, dShield, liveLight, cumLight, dLight, updated:C.updated_at}); }
    }

    const SN = snap.get(u);
    if (SN){ if(SN.dto_version!==WEEKLY_CARDS_DTO_VERSION) snapVerStale++; if(SN.is_stale) snapStaleFlag++; }
  }

  console.log("\n════════ 전수 census 요약 ════════");
  console.table([{
    "유저수(point행 보유)": nUsers,
    "slim 일치": slimMatch, "slim 불일치": slimMismatch, "slim 결손(no row)": slimMiss, "slim 최대 별차이": maxSlimStar,
  }]);
  console.table([{
    "유저수": nUsers,
    "cum 일치": cumMatch, "cum 불일치": cumMismatch, "cum 결손": cumMiss, "cum 최대 별차이": maxCumStar,
  }]);
  console.log("dto_version drift:", { code: WEEKLY_CARDS_DTO_VERSION,
    "slim 버전≠code": slimVerStale, "snapshot 버전≠code": snapVerStale, "snapshot is_stale=true": snapStaleFlag,
    "snapshot rows": snapRows.length, "slim rows": slimRows.length, "cum rows": cumRows.length });

  console.log("\n──── SLIM 불일치 상세 (별/방패/번개 중 하나라도) ────");
  if (slimMismatches.length===0) console.log("  (없음)");
  else console.table(slimMismatches.slice(0,60));

  console.log("\n──── CUM(materialized) 불일치 상세 ────");
  if (cumMismatches.length===0) console.log("  (없음)");
  else console.table(cumMismatches.slice(0,60));

  console.log("\n[done] READ-ONLY. nUsers="+nUsers);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
