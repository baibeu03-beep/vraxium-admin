// ─────────────────────────────────────────────────────────────────────
// 2025-summer W5~W8 publish 보호 가드 (2026-06-07 운영 확정 정책).
//
// 배경: 06-07 00:30 이동 작업(졸업 인정 주차 = W5~W8, published 선세팅)과
//   01:03 PMS 정본 복원 작업(전부 미공표)이 같은 4행을 서로 덮어써
//   표시 성공주차 a 가 30→26 으로 회귀했다(세션 간 충돌).
//   → 운영 확정: W5~W8 의 result_published_at = start_date + 7일 고정.
//
// 사용처: weeks 테이블을 쓰는 모든 백필/복원 apply 스크립트의 preflight
//   (dry-run 포함)에서 호출 — 기대값과 다르면 throw(실행 중단).
//   write 루프에서는 assertProtectedPublishWrite 로 쓰기 의도 자체를 차단.
//
// 정책 변경 시: 이 파일의 기대값을 바꾸고, 변경 근거를 주석으로 남길 것
//   (개별 스크립트에서 가드를 우회하지 말 것 — 충돌 재발 경로).
// ─────────────────────────────────────────────────────────────────────

export const PROTECTED_SUMMER_SEASON_KEY = "2025-summer";

// 졸업 인정 주차 4행 (claudedocs/summer-weeks-move-w5-8-20260607.md).
export const PROTECTED_SUMMER_PUBLISH_WEEKS = [
  { week: 5, start: "2025-07-28" },
  { week: 6, start: "2025-08-04" },
  { week: 7, start: "2025-08-11" },
  { week: 8, start: "2025-08-18" },
] as const;

export const PROTECTED_SUMMER_STARTS: ReadonlySet<string> = new Set(
  PROTECTED_SUMMER_PUBLISH_WEEKS.map((w) => w.start),
);

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 기대 publish 값 = start_date + 7일 (이동 스크립트 선세팅 산식과 동일).
export function expectedPublishedAt(start: string): string {
  return `${addDaysIso(start, 7)}T00:00:00+00:00`;
}

export class SummerPublishGuardError extends Error {
  constructor(lines: string[]) {
    super(
      [
        "⛔ 2025-summer W5~W8 publish 가드 위반 — 실행 중단:",
        ...lines.map((l) => "  - " + l),
        "",
        "  기대값: result_published_at = start_date + 7일 (졸업 인정 주차 정책, 2026-06-07 운영 확정)",
        "  복구: npx tsx --env-file=.env.local scripts/fix-summer-w5-8-publish-restore.ts --apply",
        "  정책 변경이 필요하면 lib/summerWeeksPublishGuard.ts 의 기대값을 수정할 것(스크립트별 우회 금지).",
      ].join("\n"),
    );
    this.name = "SummerPublishGuardError";
  }
}

// 최소 구조 타입 — 스크립트들이 자체 createClient 를 쓰므로 supabaseAdmin 에 묶지 않는다.
type SupabaseLike = {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        in(
          col: string,
          vals: string[],
        ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * 현재 DB 상태가 보호 기대값과 일치하는지 검사 (preflight·dry-run 용).
 * 불일치 시 SummerPublishGuardError throw — 호출측은 잡지 말고 중단할 것.
 */
export async function assertSummerW58PublishGuard(sb: SupabaseLike): Promise<void> {
  const starts = PROTECTED_SUMMER_PUBLISH_WEEKS.map((w) => w.start);
  const { data, error } = await sb
    .from("weeks")
    .select("week_number,start_date,result_published_at")
    .eq("season_key", PROTECTED_SUMMER_SEASON_KEY)
    .in("start_date", starts);
  if (error) throw new SummerPublishGuardError([`weeks 조회 실패: ${error.message}`]);

  const rows = (data ?? []) as Array<{
    week_number: number | null;
    start_date: string;
    result_published_at: string | null;
  }>;
  const byStart = new Map(rows.map((r) => [r.start_date, r]));
  const problems: string[] = [];
  for (const w of PROTECTED_SUMMER_PUBLISH_WEEKS) {
    const row = byStart.get(w.start);
    if (!row) {
      problems.push(`W${w.week}(${w.start}): 행 부재`);
      continue;
    }
    const expected = expectedPublishedAt(w.start);
    if (row.result_published_at !== expected) {
      problems.push(
        `W${w.week}(${w.start}): result_published_at=${JSON.stringify(row.result_published_at)} ≠ 기대 ${expected}`,
      );
    }
  }
  if (rows.length > PROTECTED_SUMMER_PUBLISH_WEEKS.length) {
    problems.push(`보호 구간 행수 ${rows.length} > 4 (중복 행 의심)`);
  }
  if (problems.length > 0) throw new SummerPublishGuardError(problems);
}

/**
 * 쓰기 의도 가드 — weeks update/insert 루프에서 호출.
 * 보호 행의 result_published_at 을 기대값 외로 바꾸려는 쓰기를 차단한다.
 * (기대값 그대로 쓰는 복원/롤백은 허용.)
 */
export function assertProtectedPublishWrite(input: {
  start: string;
  col: string;
  value: unknown;
}): void {
  if (input.col !== "result_published_at") return;
  if (!PROTECTED_SUMMER_STARTS.has(input.start)) return;
  const expected = expectedPublishedAt(input.start);
  if (input.value !== expected) {
    throw new SummerPublishGuardError([
      `쓰기 의도 차단: ${input.start} result_published_at → ${JSON.stringify(input.value)} (기대 ${expected} 외 변경 금지)`,
    ]);
  }
}
