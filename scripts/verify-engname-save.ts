/** B1 검증: 편집 저장(PUT) 시 eng_name→english_name 매핑이 실제로 저장되는지 (HTTP 왕복). 끝나면 원복. */
import { createClient } from "@supabase/supabase-js";
const env = process.env as Record<string,string>;
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth:{persistSession:false} });
const BASE = "http://localhost:3001/api/profile/";
const TEST_UID = "37b7ddce-6146-4941-8c5f-c1dfa4e09f7e"; // T안준혁 (test_user_marker)
async function getHttp(uid:string){ const r=await fetch(`${BASE}?userId=${uid}`); const j=await r.json(); return {status:r.status, eng:(j.data||j).english_name, addr:(j.data||j).address}; }
async function put(body:any){ const r=await fetch(BASE,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); const j=await r.json().catch(()=>({})); return {status:r.status, success:j.success, error:j.error}; }
async function main(){
  const isMarker = (await sb.from("test_user_markers").select("user_id").eq("user_id",TEST_UID).maybeSingle()).data;
  console.log("test_user_marker 등록?", !!isMarker);
  const orig = (await sb.from("user_profiles").select("english_name").eq("user_id",TEST_UID).maybeSingle()).data?.english_name ?? null;
  console.log("원본 english_name:", JSON.stringify(orig));
  const SENTINEL = "Verify Engsave Zzz";
  try{
    // 1) PUT sentinel via 레거시 키 eng_name (클라이언트가 실제로 보내는 키) + demoUserId 쓰기 경로
    const p1 = await put({ eng_name: SENTINEL, demoUserId: TEST_UID });
    console.log("PUT(eng_name=sentinel):", p1);
    // 2) GET 으로 재조회
    const g1 = await getHttp(TEST_UID);
    console.log("GET 후 english_name:", JSON.stringify(g1.eng), "| HTTP", g1.status);
    console.log(g1.eng===SENTINEL ? "✔ 저장→재조회 OK (eng_name→english_name 매핑 동작·500 없음)" : "✖ 불일치 — 저장 실패");
  } finally {
    // 3) 원복
    const pr = await put({ eng_name: orig ?? "", demoUserId: TEST_UID });
    const gr = await getHttp(TEST_UID);
    console.log("원복 PUT:", pr, "| 원복 후 english_name:", JSON.stringify(gr.eng));
    console.log(gr.eng===orig ? "✔ 원복 완료" : "⚠ 원복 확인 필요");
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
