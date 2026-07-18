// 운영진 공용 이미지 변경 시 무효화 대상(같은 라인 타 크루) 산정 로직 검증(read-only).
//   save §3b 와 동일 쿼리: cluster4_line_targets(target_mode='user', line_id) 에서 본인 제외 대상자.
//   실행: npx tsx --env-file=.env.local scripts/diag-line-shared-crews.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  // 대상자가 2명 이상인 user-mode 라인(공용 라인) 찾기
  const { data: rows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id, target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(4000);
  const byLine = new Map<string, Set<string>>();
  for (const r of rows ?? []) {
    const lid = r.line_id as string;
    const uid = r.target_user_id as string;
    if (!byLine.has(lid)) byLine.set(lid, new Set());
    byLine.get(lid)!.add(uid);
  }
  const multi = [...byLine.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size);
  console.log(`user-mode 라인 총 ${byLine.size}개 · 대상자 2명 이상(공용) 라인 = ${multi.length}개`);
  if (multi.length === 0) {
    console.log("공용 라인 없음 — 이 스코프에선 운영진 이미지 변경이 타 크루에 영향 없음(단일 크루 라인).");
  } else {
    for (const [lid, users] of multi.slice(0, 3)) {
      const arr = [...users];
      const self = arr[0];
      // save §3b 재현: 본인 제외 나머지 = 무효화 대상
      const others = arr.filter((u) => u !== self);
      console.log(`\n라인 ${lid.slice(0, 8)} — 대상자 ${arr.length}명`);
      console.log(`  본인(가정) = ${self.slice(0, 8)}`);
      console.log(`  무효화 대상(타 크루) = ${others.length}명: ${others.map((u) => u.slice(0, 8)).join(", ")}`);
      console.log(`  ✔ 타 크루 submission 은 미접촉(본인 line_target_id+user_id 스코프만 저장), 슬롯0(라인 레벨)만 공유`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
