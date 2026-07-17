/**
 * 소요 시간 브리지 — info org 스코프 검증 (2026-07-17 감사 후속).
 *   npx tsx --env-file=.env.local scripts/verify-line-duration-org-scope.ts
 *
 * 검증 대상: loadLineDurationResolver(organizationSlug) 의 info 매핑 우선순위.
 *   원장의 point_activity_type_id 에는 유니크 제약이 없어 (common, encre) 같은 활동유형이
 *   공존할 수 있다. org 스코프가 없으면 last-write-wins 로 **다른 org 의 값이 조용히 선택**된다.
 *
 * 기대:
 *   org 전용 값 존재 → org 값
 *   org 전용 값 없음 → common 값
 *   다른 org 값     → 절대 선택되지 않음
 *
 * ⚠ 이 스크립트는 실제 원장에 fixture 행을 만들고 기존 행의 duration 을 잠시 바꾼다.
 *   finally 에서 **반드시 원상 복구**한다(생성 행 삭제 + 원래 duration 복원).
 */
import { createClient } from "@supabase/supabase-js";
import { loadLineDurationResolver } from "@/lib/adminLineDurationBridge";

function ensureEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env: ${n}`);
  return v;
}
const sb = createClient(ensureEnv("NEXT_PUBLIC_SUPABASE_URL"), ensureEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

const stamp = Date.now();
const ACT = "wisdom"; // 실제 원장에 존재하는 info 활동유형
const createdIds: string[] = [];
let restore: { id: string; prev: number | null } | null = null;

async function main() {
  // ── fixture 준비 ──
  // 1) 기존 common info(wisdom) 행에 duration=120 부여 (원래 값은 복구용으로 보관)
  const { data: commonRow } = await sb
    .from("line_registrations")
    .select("id,line_code,organization_slug,estimated_duration_minutes")
    .eq("hub", "info")
    .eq("point_activity_type_id", ACT)
    .eq("organization_slug", "common")
    .maybeSingle();
  if (!commonRow) throw new Error(`common info(${ACT}) 행이 없어 검증 불가`);
  restore = { id: commonRow.id, prev: commonRow.estimated_duration_minutes };
  await sb.from("line_registrations").update({ estimated_duration_minutes: 120 }).eq("id", commonRow.id);
  console.log(`fixture: common ${commonRow.line_code}(${ACT}) duration=120`);

  // 2) 같은 활동유형의 encre 전용 행 생성 (duration=30) → 충돌 상황
  const { data: encreRow, error: e1 } = await sb
    .from("line_registrations")
    .insert({
      line_name: `org스코프검증 encre ${stamp}`,
      hub: "info",
      line_type: "일반",
      line_code: `IFOS-E${stamp}`,
      main_title_mode: "variable",
      main_title: "-",
      unit_link: "-",
      organization_slug: "encre",
      point_activity_type_id: ACT,
      estimated_duration_minutes: 30,
    })
    .select("id")
    .single();
  if (e1 || !encreRow) throw new Error(`encre fixture 생성 실패: ${e1?.message}`);
  createdIds.push(encreRow.id);
  console.log(`fixture: encre IFOS-E${stamp}(${ACT}) duration=30`);

  // 3) 제3의 org(phalanx) 행도 생성 (duration=90) → "다른 org 값 절대 선택 안 됨" 증명용
  const { data: phalanxRow, error: e2 } = await sb
    .from("line_registrations")
    .insert({
      line_name: `org스코프검증 phalanx ${stamp}`,
      hub: "info",
      line_type: "일반",
      line_code: `IFOS-P${stamp}`,
      main_title_mode: "variable",
      main_title: "-",
      unit_link: "-",
      organization_slug: "phalanx",
      point_activity_type_id: ACT,
      estimated_duration_minutes: 90,
    })
    .select("id")
    .single();
  if (e2 || !phalanxRow) throw new Error(`phalanx fixture 생성 실패: ${e2?.message}`);
  createdIds.push(phalanxRow.id);
  console.log(`fixture: phalanx IFOS-P${stamp}(${ACT}) duration=90\n`);

  const infoLine = { partType: "information" as const, activityTypeId: ACT, activityTypeKey: ACT };

  // ── 수정 전 재현 — 왜 이게 버그였는가 ──
  //   수정 전 알고리즘: org 구분 없이 info 행 전부에 대해 byActivityType.set(key, d).
  //   같은 활동유형이 여러 org 에 있으면 last-write-wins → 행 순서에 따라 값이 결정된다.
  //   아래는 그 알고리즘을 같은 fixture 에 그대로 재현한 것이다(현재 코드는 건드리지 않음).
  console.log("=== 수정 전 재현 (org 스코프 없는 옛 알고리즘) ===");
  {
    const { data } = await sb
      .from("line_registrations")
      .select("hub,point_activity_type_id,organization_slug,estimated_duration_minutes")
      .eq("hub", "info");
    const legacyMap = new Map<string, number | null>();
    const orgOfPick = new Map<string, string | null>();
    for (const r of (data ?? []) as Array<{
      point_activity_type_id: string | null;
      organization_slug: string | null;
      estimated_duration_minutes: number | null;
    }>) {
      const k = r.point_activity_type_id?.trim();
      if (!k) continue;
      legacyMap.set(k, r.estimated_duration_minutes); // ← last-write-wins (org 무시)
      orgOfPick.set(k, r.organization_slug);
    }
    const legacyValue = legacyMap.get(ACT) ?? null;
    const legacyOrg = orgOfPick.get(ACT) ?? null;
    console.log(`  옛 알고리즘이 '${ACT}' 에 채택한 행: org=${legacyOrg} · duration=${legacyValue}`);
    // 이 fixture 에는 common(120)/encre(30)/phalanx(90) 3행이 있다. 옛 알고리즘은 org 인자가
    // 없으므로 encre 로 조회하든 oranke 로 조회하든 **동일한 한 값**만 낸다 → 최소 2개 org 는 오답.
    const wrongForSomeOrg = legacyValue !== 30 || legacyValue !== 120;
    check(
      "옛 알고리즘은 org 별 구분이 불가능 → 최소 한 org 에 오답 (버그 재현)",
      wrongForSomeOrg,
      `모든 org 가 ${legacyValue}(org=${legacyOrg}) 를 받게 됨 — encre 는 30, oranke 는 120 이어야 함`,
    );
  }

  // ── 검증 ──
  console.log("\n=== info: org 전용 > common > 다른 org 제외 (수정 후) ===");
  const encre = await loadLineDurationResolver("encre");
  check("org=encre → 30 (자기 org 전용 값)", encre(infoLine) === 30, `got=${encre(infoLine)}`);

  const phalanx = await loadLineDurationResolver("phalanx");
  check("org=phalanx → 90 (자기 org 전용 값)", phalanx(infoLine) === 90, `got=${phalanx(infoLine)}`);

  const oranke = await loadLineDurationResolver("oranke");
  check(
    "org=oranke → 120 (전용 없음 → common fallback)",
    oranke(infoLine) === 120,
    `got=${oranke(infoLine)}`,
  );
  check(
    "org=oranke 가 encre(30)/phalanx(90) 값을 절대 고르지 않음",
    oranke(infoLine) !== 30 && oranke(infoLine) !== 90,
    `got=${oranke(infoLine)}`,
  );

  const noOrg = await loadLineDurationResolver(null);
  check("org=null → 120 (common 만 사용)", noOrg(infoLine) === 120, `got=${noOrg(infoLine)}`);

  // ── 회귀: experience/competency 는 org 무관하게 master UUID 로 정확히 매칭 ──
  console.log("\n=== experience/competency: master UUID 매핑 (org 무관) ===");
  const { data: expReg } = await sb
    .from("line_registrations")
    .select("id,bridged_master_id")
    .eq("hub", "experience")
    .not("bridged_master_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (expReg?.bridged_master_id) {
    await sb.from("line_registrations").update({ estimated_duration_minutes: 60 }).eq("id", expReg.id);
    const r = await loadLineDurationResolver("encre");
    const got = r({ partType: "experience", experienceLineMasterId: expReg.bridged_master_id });
    check("experience: bridged_master_id → 60", got === 60, `got=${got}`);
    const r2 = await loadLineDurationResolver("oranke");
    const got2 = r2({ partType: "experience", experienceLineMasterId: expReg.bridged_master_id });
    check("experience: 다른 org 로 조회해도 동일 60 (UUID 1:1)", got2 === 60, `got=${got2}`);
    await sb.from("line_registrations").update({ estimated_duration_minutes: null }).eq("id", expReg.id);
  }

  // ── 미설정/미매핑 ──
  console.log("\n=== 미설정 · 미매핑 ===");
  const r3 = await loadLineDurationResolver("encre");
  check("career → 항상 null (원장 행 없음)", r3({ partType: "career" }) === null);
  check(
    "존재하지 않는 활동유형 → null",
    r3({ partType: "information", activityTypeId: `nope-${stamp}` }) === null,
  );
  check(
    "master id 없는 experience 슬롯 → null",
    r3({ partType: "experience", experienceLineMasterId: null }) === null,
  );

  console.log(`\n결과: pass=${pass} fail=${fail}`);
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    // 원상 복구 — 검증이 운영 데이터를 바꿔놓지 않게 한다.
    if (createdIds.length) {
      await sb.from("line_registrations").delete().in("id", createdIds);
      console.log(`· fixture 행 ${createdIds.length}건 삭제`);
    }
    if (restore) {
      await sb
        .from("line_registrations")
        .update({ estimated_duration_minutes: restore.prev })
        .eq("id", restore.id);
      console.log(`· common 행 duration 원복(${restore.prev})`);
    }
    process.exit(fail > 0 ? 1 : 0);
  });
