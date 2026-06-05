/**
 * READ-ONLY 진단: 이력서 resume-skills 4개 skill-num 전수 기준 대조.
 *   (1) 실무 정보 습득  infoCount        — fetchInfoLineSuccessCountsByWeek
 *   (2) 실무 경험 축적  experienceCount  — fetchLineSuccessCountsByWeek("experience")
 *   (3) 실무 역량 성장  abilityUnitCount — fetchLineSuccessCountsByWeek("competency")
 *   (4) 실무 경력 누적  careerProjectCount — fetchCareerLineSuccessCountsByWeek
 *
 * 각 part 별로:
 *   A. resume 식 값 (direct getCluster1Resume)
 *   B. 허브 식 값 (fetchWeeklyCardLineAggregates — exp rating<=3 제외·career grade)
 *   C. 정책 목표 값 = 공표 완료 주차 + 강화 성공만(실패 제외·미평가 제외)
 *   D. 분해: closed / rating-fail / unrated / unpublished-week
 *   E. (옵션) 로컬 dev 서버 HTTP /api/cluster1/resume 응답 대조
 * 사용: npx tsx --env-file=.env.local scripts/diag-resume-skills-4nums.ts <userId...>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function httpResume(uid: string): Promise<any | null> {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`http://localhost:3000/api/cluster1/resume?userId=${uid}`, {
      headers: { "x-internal-api-key": key },
    });
    if (!res.ok) return { httpError: res.status };
    const j = await res.json();
    return j?.data?.practicalStats ?? null;
  } catch {
    return null; // dev 서버 미기동
  }
}

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("usage: diag-resume-skills-4nums.ts <userId...>");
    process.exit(1);
  }
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");
  const { fetchWeeklyCardLineAggregates } = await import("../lib/lineAvailability");

  for (const uid of ids) {
    console.log(`\n══════ user ${uid} ══════`);

    // A. direct DTO
    const dto = await getCluster1Resume(uid);
    console.log("[A. direct practicalStats]", JSON.stringify(dto?.practicalStats));

    // E. HTTP (있으면)
    const http = await httpResume(uid);
    console.log("[E. HTTP practicalStats ]", http ? JSON.stringify(http) : "(dev 서버 미기동/키 없음 — 코드상 동일 함수 프록시)");

    // raw 주차 + 공표
    const { data: uws } = await sb
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", uid);
    const starts = (uws ?? []).map((w: any) => w.week_start_date);
    const { data: weeks } = await sb
      .from("weeks")
      .select("id,start_date,result_published_at")
      .in("start_date", starts.length ? starts : ["1970-01-01"]);
    const weekIds = (weeks ?? []).map((w: any) => w.id);
    const weekById = new Map((weeks ?? []).map((w: any) => [w.id, w]));
    // weeks 행 없는 과거 주차는 resume seasonRecords 와 동일하게 공표 간주.
    const isPublished = (weekId: string) => {
      const w: any = weekById.get(weekId);
      return w ? Boolean(w.result_published_at) : true;
    };

    // 타깃 전수 + 라인 + 평가
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("id,week_id,line_id")
      .eq("target_mode", "user")
      .eq("target_user_id", uid)
      .in("week_id", weekIds.length ? weekIds : ["00000000-0000-0000-0000-000000000000"]);
    const lineIds = [...new Set((targets ?? []).map((t: any) => t.line_id))];
    const { data: lines } = await sb
      .from("cluster4_lines")
      .select("id,part_type,submission_closes_at,is_active")
      .in("id", lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"]);
    const lineById = new Map(
      ((lines ?? []) as any[]).filter((l) => l.is_active).map((l) => [l.id, l]),
    );

    const tAll = ((targets ?? []) as any[]).filter((t) => lineById.has(t.line_id));
    const tids = tAll.map((t) => t.id);
    const expEvals = new Map<string, number>();
    const carEvals = new Map<string, string>();
    for (let i = 0; i < tids.length; i += 100) {
      const slice = tids.slice(i, i + 100);
      const [{ data: ee }, { data: ce }] = await Promise.all([
        sb.from("cluster4_experience_line_evaluations").select("line_target_id,rating").eq("user_id", uid).in("line_target_id", slice),
        sb.from("cluster4_career_line_evaluations").select("line_target_id,grade").eq("user_id", uid).in("line_target_id", slice),
      ]);
      for (const e of (ee ?? []) as any[]) expEvals.set(e.line_target_id, e.rating);
      for (const e of (ce ?? []) as any[]) carEvals.set(e.line_target_id, e.grade);
    }

    // 허브 식
    const agg = await fetchWeeklyCardLineAggregates(uid, weekIds);
    const sum = (m: Map<string, number>) => { let s = 0; for (const v of m.values()) s += v; return s; };

    const now = Date.now();
    const PARTS: { key: string; label: string }[] = [
      { key: "info", label: "1.실무 정보 습득 (infoCount)" },
      { key: "experience", label: "2.실무 경험 축적 (experienceCount)" },
      { key: "competency", label: "3.실무 역량 성장 (abilityUnitCount)" },
      { key: "career", label: "4.실무 경력 누적 (careerProjectCount)" },
    ];
    const hubByPart: Record<string, number> = {
      info: sum(agg.infoSuccessMap),
      experience: sum(agg.experienceSuccessMap),
      competency: sum(agg.abilitySuccessMap),
      career: sum(agg.careerSuccessMap),
    };

    for (const p of PARTS) {
      const ts = tAll.filter((t) => (lineById.get(t.line_id) as any).part_type === p.key);
      let closed = 0, ratingFail = 0, unrated = 0, unpubClosed = 0, oldStyle = 0;
      const policyWeeks = new Set<string>(); // 공표+성공+평가확정, 주차 fold (확정 정책)
      for (const t of ts) {
        const l: any = lineById.get(t.line_id);
        const isClosed = l.submission_closes_at && new Date(l.submission_closes_at).getTime() < now;
        if (!isClosed) continue;
        closed++;
        const pub = isPublished(t.week_id);
        if (!pub) unpubClosed++;
        // 구 resume 식: career 만 grade 필터, 나머지는 마감만 (참고용).
        if (p.key === "career") {
          const g = carEvals.get(t.id);
          if (g && g !== "D") oldStyle++;
          if (!g) unrated++;
          if (g === "D") ratingFail++;
          if (pub && g && g !== "D") policyWeeks.add(t.week_id);
        } else if (p.key === "experience") {
          oldStyle++;
          const r = expEvals.get(t.id);
          if (r == null) unrated++;
          else if (r <= 3) ratingFail++;
          if (pub && r != null && r >= 4) policyWeeks.add(t.week_id);
        } else {
          oldStyle++;
          // info/competency: 평점 체계 없음 → 성공=마감. 공표 필터만 적용.
          if (pub) policyWeeks.add(t.week_id);
        }
      }
      const dtoVal = (dto?.practicalStats as any)?.[
        { info: "infoCount", experience: "experienceCount", competency: "abilityUnitCount", career: "careerProjectCount" }[p.key]!
      ];
      const match = dtoVal === policyWeeks.size ? "✓" : "✗";
      console.log(
        `[${p.label}] direct=${dtoVal} | 정책(공표+성공+fold)=${policyWeeks.size} ${match} | 구식=${oldStyle} | 허브식=${hubByPart[p.key]} || targets=${ts.length} closed=${closed} 평가실패=${ratingFail} 미평가=${unrated} 미공표마감=${unpubClosed}`,
      );
    }

    // 공표 완료 성공 주차 수 (참고)
    let pubSuccess = 0;
    for (const w of (uws ?? []) as any[]) {
      const wk = (weeks ?? []).find((x: any) => x.start_date === w.week_start_date) as any;
      if (w.status === "success" && (wk ? Boolean(wk.result_published_at) : true)) pubSuccess++;
    }
    console.log(`[참고] 공표 완료 성공 주차 수 = ${pubSuccess}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
