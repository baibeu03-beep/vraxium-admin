// 일회성 점검(READ-ONLY): snapshot 테이블 접근 제어/적용 여부 확인.
//   npx tsx --env-file=.env.local scripts/check-snapshot-prereq.ts
//
// 기대(마이그레이션 적용 후):
//   [service] read: ok           ← service_role 는 읽기/쓰기 가능(RLS 우회)
//   [anon] read BLOCKED (good)   ← 공개 anon 키로는 전체 사용자 데이터 조회 불가
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
console.log("url:", !!url, "| service:", !!serviceKey, "| anon:", !!anonKey);
if (!url || !serviceKey) process.exit(2);

const TABLE = "cluster4_weekly_card_snapshots";

async function main() {
  const svc = createClient(url!, serviceKey!);

  // service_role 읽기(정확 count). PGRST205 면 테이블 미적용(또는 PostgREST 스키마 캐시 미반영).
  const svcRead = await svc.from(TABLE).select("user_id").limit(1);
  if (svcRead.error) {
    console.log("[service] read:", `ERR ${svcRead.error.code} ${svcRead.error.message}`);
    console.log("→ 테이블 미적용. 마이그레이션 적용 후 다시 실행하세요.");
    return;
  }
  const cnt = await svc.from(TABLE).select("user_id", { count: "exact", head: true });
  console.log("[service] read: ok | rows =", cnt.count);

  // anon 키 읽기 — 막혀 있어야 정상(cross-user 노출 방지).
  if (anonKey) {
    const anon = createClient(url!, anonKey);
    const anonRead = await anon.from(TABLE).select("user_id").limit(1);
    if (anonRead.error) {
      console.log("[anon] read BLOCKED (good):", anonRead.error.code, anonRead.error.message);
    } else {
      console.log("[anon] read ALLOWED (⚠ 노출 위험 — RLS/GRANT 재확인 필요): rows =", anonRead.data?.length);
    }
  } else {
    console.log("[anon] anon key 없음 → 테스트 생략");
  }
}
main().catch((e) => { console.error("fatal", e); process.exit(1); });
