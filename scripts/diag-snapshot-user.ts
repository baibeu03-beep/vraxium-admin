// 특정 userId 의 snapshot 상태/혼동 추적(READ-ONLY).
// 로그에 MISS/STALE/504 로 찍힌 userId 를 그대로 넣어 원인을 판별한다.
//   npx tsx --env-file=.env.local scripts/diag-snapshot-user.ts <userId>
//
// 확인:
//   - 입력 id 가 profile user_id 인지 auth id 인지 (resolveProfileUserId 결과와 비교)
//   - snapshot 테이블에 입력 id / 해소된 profile id 로 행이 있는지
//   - 읽기 outcome(hit/stale/miss/error) 과 dto_version
import { createClient } from "@supabase/supabase-js";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function rowFor(id: string) {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,card_count,computed_at")
    .eq("user_id", id)
    .maybeSingle();
  return data as
    | { user_id: string; dto_version: number; is_stale: boolean; card_count: number; computed_at: string }
    | null;
}

async function main() {
  const input = process.argv[2]?.trim();
  if (!input) {
    console.log("사용법: npx tsx --env-file=.env.local scripts/diag-snapshot-user.ts <userId>");
    process.exit(2);
  }
  console.log(`입력 id            : ${input}`);

  // auth id → profile id 해소(같으면 입력이 이미 profile id 일 가능성).
  let resolved: string | null = null;
  try {
    resolved = await resolveProfileUserId(input, null);
  } catch (e) {
    console.log("resolveProfileUserId 오류:", e instanceof Error ? e.message : e);
  }
  console.log(`resolveProfileUserId: ${resolved ?? "(null)"}`);
  console.log(
    `→ 입력 id 는 ${resolved === input ? "이미 profile user_id (혼동 없음)" : resolved ? "auth id 로 보이며 profile 로 해소됨" : "어느 쪽으로도 해소 안 됨"}`,
  );

  // 입력 id / 해소된 id 양쪽에서 snapshot 행 확인.
  const rawRow = await rowFor(input);
  console.log(`snapshot[입력 id]   : ${rawRow ? `존재 (v${rawRow.dto_version}, stale=${rawRow.is_stale}, cards=${rawRow.card_count})` : "없음"}`);
  if (resolved && resolved !== input) {
    const resRow = await rowFor(resolved);
    console.log(`snapshot[profile id]: ${resRow ? `존재 (v${resRow.dto_version}, stale=${resRow.is_stale}, cards=${resRow.card_count})` : "없음"}`);
  }

  // 라우트가 실제로 읽는 키(=profile id)로 outcome 판정.
  const key = resolved ?? input;
  const outcome = await readWeeklyCardsSnapshot(key);
  console.log(`읽기 키(profile id) : ${key}`);
  console.log(`읽기 outcome        : ${outcome.status}${outcome.status === "stale" ? `(${outcome.reason})` : ""}`);
  console.log(`CODE 기대 버전       : ${WEEKLY_CARDS_DTO_VERSION}`);

  const verdict =
    outcome.status === "hit"
      ? "정상 — 조회 시 HIT(쿼리 1, 무계산)."
      : outcome.status === "stale"
        ? "STALE — 구 카드 노출 + cron 재생성 예정(조회 시 무계산)."
        : outcome.status === "miss"
          ? "MISS — 행 없음/손상. 조회 시 빈 배열 + cron 큐잉(무계산). 백필/cron 누락 여부 확인."
          : "ERROR — snapshot SELECT 실패(무계산, 빈 배열+error). 일시 오류/권한 확인.";
  console.log(`판정               : ${verdict}`);
}
main().catch((e) => { console.error("fatal", e); process.exit(1); });
