import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TABLE = "cluster4_weekly_card_snapshots";
const DTO = 27;

const { data: profs } = await sb.from("user_profiles").select("user_id").eq("organization_slug","phalanx");
const uids = profs.map(p=>p.user_id);
let fresh=0, stale=0, versionOld=0, missing=0;
const staleIds=[], missingIds=[];
for (let i=0;i<uids.length;i+=100){
  const slice = uids.slice(i,i+100);
  const { data: snaps, error } = await sb.from(TABLE).select("user_id,is_stale,dto_version").in("user_id", slice);
  if (error) { console.log("ERR", error.message); process.exit(1); }
  const m = new Map((snaps||[]).map(s=>[s.user_id,s]));
  for (const u of slice){
    const r = m.get(u);
    if (!r){ missing++; missingIds.push(u); }
    else if (r.is_stale===true){ stale++; staleIds.push(u); }
    else if (r.dto_version!==DTO){ versionOld++; staleIds.push(u); }
    else fresh++;
  }
}
console.log("phalanx audience:", uids.length);
console.log("  fresh(is_stale=false & dto="+DTO+"):", fresh);
console.log("  STALE(is_stale=true):", stale);
console.log("  version_mismatch:", versionOld);
console.log("  MISSING(no row):", missing);
console.log("  -> needs recompute:", stale+versionOld+missing);
// write the needs-recompute id list for the completion step
import { writeFileSync } from "node:fs";
writeFileSync("./__forum_recompute_ids.json", JSON.stringify([...staleIds, ...missingIds]));
console.log("wrote needs-recompute ids:", staleIds.length+missingIds.length);
