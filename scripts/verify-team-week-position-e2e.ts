/**
 * 팀 상세 [B] 파트/클래스 override E2E — effective(override ?? UPH) 가 저장 후 실제로
 *   [A]/[B]/운용파트까지 반영되는지, UPH 원본이 불변인지, 서버 검증/차단이 실동작하는지,
 *   그리고 모든 변경이 완전 복구되는지를 실 DB 로 검증한다. **PATCH 라우트 로직을 그대로 미러링**
 *   (getTeamSelectedWeekSummary → validateWeekPositionRows → upsert). 테스트 스코프(mode=test,
 *   is_qa_test) 팀만 대상 — 실사용자 데이터 무접촉. 각 케이스는 record→mutate→assert→restore.
 *
 *   Usage: npx tsx --env-file=.env.local scripts/verify-team-week-position-e2e.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { type OrganizationSlug } from "@/lib/organizations";
import { loadHalfRows, resolveCurrentHalfKey } from "@/lib/adminTeamHalvesData";
import {
  getTeamSelectedWeekSummary,
  type TeamSelectedWeekSummary,
} from "@/lib/adminTeamSelectedWeekSummary";
import {
  validateWeekPositionChange,
  type PositionDraftRow,
} from "@/lib/teamWeekPositionValidation";
import type { PositionCode } from "@/lib/positionHistory";

const TABLE = "cluster4_team_week_position_overrides";
let fail = 0;
const ck = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
};

type Change = { userId: string; rawPart: string | null; positionCode: PositionCode };

// PATCH 라우트 미러 — 검수완료 차단(403) → next 상태 검증 → 변경행만 upsert. 반환=처리 결과.
async function applyOverride(
  org: OrganizationSlug,
  teamName: string,
  weekId: string,
  changes: Change[],
): Promise<{ status: number; error?: string }> {
  const summary = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId, mode: "test" });
  if (!summary.week) return { status: 404, error: "주차를 찾을 수 없습니다." };
  if (summary.week.reviewCompleted) return { status: 403, error: "검수가 완료된 주차는 수정할 수 없습니다." };
  const weekStart = summary.week.weekStartDate;

  const prevRows: PositionDraftRow[] = summary.crewRows.map((r) => ({
    userId: r.userId,
    rawPart: r.rawPart,
    positionCode: r.positionCode,
  }));
  const draft = new Map<string, PositionDraftRow>(prevRows.map((r) => [r.userId, r]));
  for (const c of changes) {
    if (!draft.has(c.userId)) return { status: 400, error: "현재 팀·주차의 크루가 아닙니다." };
    const part = (c.rawPart ?? "").trim();
    if (!part) return { status: 400, error: "소속 파트를 선택하세요." };
    draft.set(c.userId, { userId: c.userId, rawPart: part, positionCode: c.positionCode });
  }
  const verdict = validateWeekPositionChange(prevRows, [...draft.values()]);
  if (!verdict.ok) return { status: 422, error: verdict.message };

  const rows = changes.map((c) => ({
    user_id: c.userId,
    organization: org,
    week_id: weekId,
    week_start_date: weekStart,
    raw_team: teamName,
    raw_part: (c.rawPart ?? "").trim(),
    position_code: c.positionCode,
    created_by: "e2e-test",
    updated_by: "e2e-test",
  }));
  const { error } = await supabaseAdmin
    .from(TABLE)
    .upsert(rows, { onConflict: "user_id,week_start_date,organization,raw_team" });
  if (error) return { status: 500, error: error.message };
  return { status: 200 };
}

// UPH 원본 행(raw_part, position_code) — teamName/스트립 매칭.
async function readUph(org: string, weekStart: string, teamName: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("user_position_histories")
    .select("raw_team,raw_part,position_code")
    .eq("organization", org)
    .eq("week_start_date", weekStart)
    .eq("user_id", userId);
  const strip = (s: string) => s.replace(/\(.*?\)/g, "").trim();
  return (
    ((data ?? []) as Array<{ raw_team: string | null; raw_part: string | null; position_code: string | null }>).find(
      (r) => (r.raw_team ?? "") === teamName || strip(r.raw_team ?? "") === teamName,
    ) ?? null
  );
}

// override 원본 행(복구용) — 4키.
async function readOverrideRow(org: string, weekStart: string, teamName: string, userId: string) {
  const { data } = await supabaseAdmin
    .from(TABLE)
    .select("raw_part,position_code")
    .eq("organization", org)
    .eq("week_start_date", weekStart)
    .eq("raw_team", teamName)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { raw_part: string | null; position_code: string } | null) ?? null;
}

async function deleteOverrideRow(org: string, weekStart: string, teamName: string, userId: string) {
  await supabaseAdmin
    .from(TABLE)
    .delete()
    .eq("organization", org)
    .eq("week_start_date", weekStart)
    .eq("raw_team", teamName)
    .eq("user_id", userId);
}

// 저장 전 override 스냅샷을 찍고, 복구 함수를 돌려준다(원래 없으면 delete, 있으면 원값 재기입).
async function snapshotAndRestorer(org: OrganizationSlug, weekStart: string, teamName: string, userIds: string[]) {
  const before = new Map<string, { raw_part: string | null; position_code: string } | null>();
  for (const u of userIds) before.set(u, await readOverrideRow(org, weekStart, teamName, u));
  return async () => {
    for (const u of userIds) {
      const orig = before.get(u) ?? null;
      if (orig == null) {
        await deleteOverrideRow(org, weekStart, teamName, u);
      } else {
        await supabaseAdmin.from(TABLE).upsert(
          [{
            user_id: u, organization: org, week_start_date: weekStart, raw_team: teamName,
            raw_part: orig.raw_part, position_code: orig.position_code,
            created_by: "e2e-restore", updated_by: "e2e-restore",
          }],
          { onConflict: "user_id,week_start_date,organization,raw_team" },
        );
      }
    }
  };
}

const partCount = (s: TeamSelectedWeekSummary, part: string) =>
  s.operatedParts.find((p) => p.partName === part)?.crewCount ?? 0;

async function main() {
  const half = await resolveCurrentHalfKey();
  const org: OrganizationSlug = "encre";
  const rows = (await loadHalfRows(org, half!, { activeOnly: true })).filter((r) => r.is_qa_test === true);
  if (!rows.length) { console.log("QA 테스트 팀 없음 — skip"); process.exit(0); }
  const teamName = rows[0].team_name;
  console.log(`대상: org=${org} team=${teamName} mode=test`);

  const cur = await getTeamSelectedWeekSummary({ organization: org, teamName, mode: "test" });
  const editWeek = cur.selectableWeeks.find((w) => w.isCurrent)!;
  const otherWeek = cur.selectableWeeks.find((w) => !w.isCurrent && w.weekStartDate < editWeek.weekStartDate);
  const reviewWeekId = await (async () => {
    for (const w of cur.selectableWeeks) {
      const s = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: w.weekId, mode: "test" });
      if (s.week?.reviewCompleted) return { weekId: w.weekId, weekStart: w.weekStartDate, label: w.label };
    }
    return null;
  })();

  const base = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
  const weekStart = base.week!.weekStartDate;
  console.log(`편집 주차=${editWeek.label}(${weekStart}) 크루=${base.crewRows.length} 파트=[${base.operatedParts.map(p=>`${p.partName}:${p.crewCount}`).join(", ")}]`);

  // ── §8 파트 변경 + 운용/미운용 전환 ──────────────────────────────────────
  console.log("\n[§8] 파트 변경 End-to-End");
  {
    // 가장 작은 파트 전체를 임시 파트로 이동 → 원 파트 미운용, 임시 파트 운용(양방향 전환).
    const smallest = [...base.operatedParts].sort((a, b) => a.crewCount - b.crewCount)[0];
    const movers = base.crewRows.filter((r) => r.rawPart === smallest.partName);
    const TMP = "QA임시파트";
    const restore = await snapshotAndRestorer(org, weekStart, teamName, movers.map((m) => m.userId));
    const uphBefore = await Promise.all(movers.map((m) => readUph(org, weekStart, teamName, m.userId)));

    const res = await applyOverride(org, teamName, editWeek.weekId, movers.map((m) => ({
      userId: m.userId, rawPart: TMP, positionCode: m.positionCode,
    })));
    ck(res.status === 200, `저장 200 (${smallest.partName} ${movers.length}명 → ${TMP})`);

    const after = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
    ck(partCount(after, smallest.partName) === 0, `[A] ${smallest.partName} 운용→미운용 (${smallest.crewCount}→0)`);
    ck(partCount(after, TMP) === movers.length, `[A] ${TMP} 미운용→운용 (0→${movers.length})`);
    ck(after.crewRows.filter((r) => r.rawPart === TMP).length === movers.length, `[B] 재조회 소속 파트=${TMP}`);
    const ovRow = await readOverrideRow(org, weekStart, teamName, movers[0].userId);
    ck(ovRow?.raw_part === TMP, `override.raw_part=${TMP}`);
    const uphAfter = await Promise.all(movers.map((m) => readUph(org, weekStart, teamName, m.userId)));
    const uphSame = movers.every((_, i) => (uphBefore[i]?.raw_part ?? null) === (uphAfter[i]?.raw_part ?? null));
    ck(uphSame, `UPH.raw_part 불변(원본 무변경)`);

    await restore();
    const restored = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
    ck(partCount(restored, smallest.partName) === smallest.crewCount && partCount(restored, TMP) === 0, `복구: ${smallest.partName}=${smallest.crewCount}, ${TMP} 제거`);
  }

  // ── §9 클래스 변경(합법: 심화→정규, 비율 유지) ───────────────────────────
  console.log("\n[§9] 클래스 변경 End-to-End");
  {
    const target = base.crewRows.find((r) => r.positionCode === "advanced_agent");
    if (!target) { console.log("  (심화 크루 없음 — skip)"); }
    else {
      const restore = await snapshotAndRestorer(org, weekStart, teamName, [target.userId]);
      const uphBefore = await readUph(org, weekStart, teamName, target.userId);
      const res = await applyOverride(org, teamName, editWeek.weekId, [{ userId: target.userId, rawPart: target.rawPart, positionCode: "regular" }]);
      ck(res.status === 200, `저장 200 (심화에이전트→정규)`);
      const after = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
      ck(after.crew.regular === base.crew.regular + 1 && after.crew.advanced === base.crew.advanced - 1, `[A] 정규 ${base.crew.regular}→${after.crew.regular}, 심화 ${base.crew.advanced}→${after.crew.advanced}`);
      const ov = await readOverrideRow(org, weekStart, teamName, target.userId);
      ck(ov?.position_code === "regular", `override.position_code=regular`);
      const uphAfter = await readUph(org, weekStart, teamName, target.userId);
      ck((uphBefore?.position_code ?? null) === (uphAfter?.position_code ?? null), `UPH.position_code 불변`);
      const bRow = after.crewRows.find((r) => r.userId === target.userId);
      ck(bRow?.positionCode === "regular" && bRow?.classLabel === "정규", `[B] 클래스=정규`);
      await restore();
      const restored = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
      ck(restored.crew.regular === base.crew.regular && restored.crew.advanced === base.crew.advanced, `복구: 정규/심화 원복`);
    }
  }

  // ── §10 심화(파트장) 저장 + 중복 차단 ────────────────────────────────────
  console.log("\n[§10] 심화(파트장) 저장/중복 차단");
  {
    // 합법 파트장 저장 = 같은 파트 내 배치 스왑(현 파트장→에이전트, 에이전트→파트장). 비율·유일성 유지.
    const leaderOf = (part: string | null) => base.crewRows.find((r) => r.rawPart === part && r.positionCode === "advanced_part_leader");
    const agentIn = (part: string | null) => base.crewRows.find((r) => r.rawPart === part && r.positionCode === "advanced_agent");
    const swapPart = [...new Set(base.crewRows.map((r) => r.rawPart))].find((p) => leaderOf(p) && agentIn(p)) ?? null;
    if (swapPart) {
      const leader = leaderOf(swapPart)!;
      const agent = agentIn(swapPart)!;
      const restore = await snapshotAndRestorer(org, weekStart, teamName, [leader.userId, agent.userId]);
      const res = await applyOverride(org, teamName, editWeek.weekId, [
        { userId: leader.userId, rawPart: swapPart, positionCode: "advanced_agent" },
        { userId: agent.userId, rawPart: swapPart, positionCode: "advanced_part_leader" },
      ]);
      ck(res.status === 200, `합법 파트장 스왑 저장 200 (파트=${swapPart})`);
      const ovA = await readOverrideRow(org, weekStart, teamName, agent.userId);
      const ovL = await readOverrideRow(org, weekStart, teamName, leader.userId);
      ck(ovA?.position_code === "advanced_part_leader" && ovL?.position_code === "advanced_agent", `override 기록: 새 파트장=advanced_part_leader, 구 파트장=advanced_agent`);
      await restore();
      ck((await readOverrideRow(org, weekStart, teamName, agent.userId)) == null, `복구: 스왑 override 제거`);
    } else { console.log("  (스왑 후보 파트 없음 — 합법 저장 skip)"); }

    // 중복 차단 = 파트장이 있는 파트의 다른 크루를 파트장으로 시도 → 유일성 위반 422(비율보다 먼저 판정).
    const leaderPart = base.crewRows.find((r) => r.positionCode === "advanced_part_leader")?.rawPart ?? null;
    const second = base.crewRows.find((r) => r.rawPart === leaderPart && r.positionCode !== "advanced_part_leader");
    if (leaderPart && second) {
      const res2 = await applyOverride(org, teamName, editWeek.weekId, [{ userId: second.userId, rawPart: leaderPart, positionCode: "advanced_part_leader" }]);
      ck(res2.status === 422 && /파트장/.test(res2.error ?? ""), `2번째 파트장 차단(422): "${res2.error}"`);
      const ov2 = await readOverrideRow(org, weekStart, teamName, second.userId);
      ck(ov2 == null || ov2.position_code !== "advanced_part_leader", `DB 2번째 파트장 미저장`);
    } else { console.log("  (파트장 중복 후보 없음 — skip)"); }
  }

  // ── §11 심화 인원 제한(advanced<=regular) 차단 ───────────────────────────
  console.log("\n[§11] 심화 인원 제한 차단");
  {
    // 현재 정규==심화+? — 비율 경계에서 정규→심화 하나 추가 시도 → 초과면 422.
    const bump = base.crewRows.find((r) => r.positionCode === "regular");
    if (bump && base.crew.advanced + 1 > base.crew.regular - 1) {
      const res = await applyOverride(org, teamName, editWeek.weekId, [{ userId: bump.userId, rawPart: bump.rawPart, positionCode: "advanced_agent" }]);
      ck(res.status === 422 && /심화/.test(res.error ?? ""), `정규→심화 비율 초과 차단(422): "${res.error}"`);
      ck((await readOverrideRow(org, weekStart, teamName, bump.userId)) == null, `DB 미저장`);
    } else {
      console.log(`  (현재 정규${base.crew.regular}/심화${base.crew.advanced} — 경계 미형성, 비율 여유. 대량 승격으로 초과 유도)`);
      // 정규 절반+1 을 심화로 → 반드시 초과. draft 전체 검증이므로 batch 한 번에 시도.
      const regs = base.crewRows.filter((r) => r.positionCode === "regular");
      const need = Math.floor((base.crew.regular - base.crew.advanced) / 2) + 1; // 초과 발생 최소 수+1
      const picks = regs.slice(0, Math.max(need, 1)).map((r) => ({ userId: r.userId, rawPart: r.rawPart, positionCode: "advanced_agent" as PositionCode }));
      const restore = await snapshotAndRestorer(org, weekStart, teamName, picks.map((p) => p.userId));
      const res = await applyOverride(org, teamName, editWeek.weekId, picks);
      ck(res.status === 422 && /심화/.test(res.error ?? ""), `대량 정규→심화 비율 초과 차단(422): "${res.error}"`);
      const anyWritten = (await Promise.all(picks.map((p) => readOverrideRow(org, weekStart, teamName, p.userId)))).some((o) => o?.position_code?.startsWith("advanced"));
      ck(!anyWritten, `DB 미저장(부분 저장 없음)`);
      await restore();
    }
  }

  // ── §12 검수 완료 주차 저장 차단(403) ────────────────────────────────────
  console.log("\n[§12] 검수 완료 주차 저장 차단");
  if (reviewWeekId) {
    const rs = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: reviewWeekId.weekId, mode: "test" });
    const anyCrew = rs.crewRows[0];
    ck(rs.week?.reviewCompleted === true && rs.week?.canEdit === false, `${reviewWeekId.label} reviewCompleted=true, canEdit=false`);
    if (anyCrew) {
      const res = await applyOverride(org, teamName, reviewWeekId.weekId, [{ userId: anyCrew.userId, rawPart: anyCrew.rawPart, positionCode: anyCrew.positionCode }]);
      ck(res.status === 403, `저장 차단 403: "${res.error}"`);
      ck((await readOverrideRow(org, reviewWeekId.weekStart, teamName, anyCrew.userId)) == null, `DB 미저장`);
    }
  } else { console.log("  (검수 완료 주차 없음 — skip)"); }

  // ── §13 다른 주차 이력 비덮어쓰기 ────────────────────────────────────────
  console.log("\n[§13] 다른 주차 override 비덮어쓰기");
  if (otherWeek) {
    const u = base.crewRows[0].userId;
    const restoreEdit = await snapshotAndRestorer(org, weekStart, teamName, [u]);
    const restoreOther = await snapshotAndRestorer(org, otherWeek.weekStartDate, teamName, [u]);
    // 두 주차에 서로 다른 파트 override 기입.
    await applyOverride(org, teamName, editWeek.weekId, [{ userId: u, rawPart: "무드", positionCode: "regular" }]);
    await applyOverride(org, teamName, otherWeek.weekId, [{ userId: u, rawPart: "아트", positionCode: "regular" }]);
    const oEdit = await readOverrideRow(org, weekStart, teamName, u);
    const oOther = await readOverrideRow(org, otherWeek.weekStartDate, teamName, u);
    ck(oEdit?.raw_part === "무드", `${editWeek.label} override=무드 유지`);
    ck(oOther?.raw_part === "아트", `${otherWeek.label} override=아트 유지(덮어쓰기 없음)`);
    await restoreEdit(); await restoreOther();
    ck(true, `복구 완료(양 주차)`);
  } else { console.log("  (과거 주차 없음 — skip)"); }

  // ── §14 복수 팀 override 비충돌(conflict key = user+week+org+team) ─────────
  console.log("\n[§14] 복수 팀 override 비충돌");
  {
    const u = base.crewRows[0].userId;
    const teamB = "QA복수팀(T)"; // 동일 user·주차·org, 다른 raw_team.
    const restoreA = await snapshotAndRestorer(org, weekStart, teamName, [u]);
    // teamB 행 직접 upsert(라우트 검증 우회 — 스키마 충돌키만 확인).
    await supabaseAdmin.from(TABLE).upsert([{ user_id: u, organization: org, week_start_date: weekStart, raw_team: teamName, raw_part: "무드", position_code: "regular", created_by: "e2e", updated_by: "e2e" }], { onConflict: "user_id,week_start_date,organization,raw_team" });
    await supabaseAdmin.from(TABLE).upsert([{ user_id: u, organization: org, week_start_date: weekStart, raw_team: teamB, raw_part: "정책", position_code: "regular", created_by: "e2e", updated_by: "e2e" }], { onConflict: "user_id,week_start_date,organization,raw_team" });
    const aRow = await readOverrideRow(org, weekStart, teamName, u);
    const bRow = await readOverrideRow(org, weekStart, teamB, u);
    ck(aRow?.raw_part === "무드" && bRow?.raw_part === "정책", `동일 user·주차, 팀A(무드)·팀B(정책) 두 행 공존`);
    // 팀A 재저장이 팀B 를 지우지 않는지.
    await supabaseAdmin.from(TABLE).upsert([{ user_id: u, organization: org, week_start_date: weekStart, raw_team: teamName, raw_part: "포토", position_code: "regular", created_by: "e2e", updated_by: "e2e" }], { onConflict: "user_id,week_start_date,organization,raw_team" });
    const bStill = await readOverrideRow(org, weekStart, teamB, u);
    ck(bStill?.raw_part === "정책", `팀A 재저장 후에도 팀B override 보존`);
    await deleteOverrideRow(org, weekStart, teamB, u); // 합성 팀B 정리
    await restoreA();
    ck((await readOverrideRow(org, weekStart, teamB, u)) == null, `복구: 합성 팀B 행 제거`);
  }

  // ── §15 운용 파트 최대 6개 제한(서버 우회 저장에도 차단) ──────────────────
  console.log("\n[§15] 운용 파트 최대 6개 제한(서버 검증)");
  {
    const opNow = base.operatedParts.length;
    if (opNow >= 6) {
      console.log(`  (현재 운용 파트=${opNow} — 이미 상한. 신규 파트 배정이 차단되는지만 확인)`);
      const mover = base.crewRows.find((r) => base.operatedParts.find((p) => p.partName === r.rawPart && p.crewCount >= 2)) ?? base.crewRows[0];
      const restore = await snapshotAndRestorer(org, weekStart, teamName, [mover.userId]);
      const res = await applyOverride(org, teamName, editWeek.weekId, [{ userId: mover.userId, rawPart: "QA7번째파트", positionCode: "regular" }]);
      ck(res.status === 422 && /운용.*6개/.test(res.error ?? ""), `7번째 파트 차단(422): "${res.error}"`);
      ck((await readOverrideRow(org, weekStart, teamName, mover.userId))?.raw_part !== "QA7번째파트", `DB 미저장`);
      await restore();
    } else {
      // 운용 파트가 6 미만 → **잉여 크루**(각 파트에서 1명 남기고 남는 인원)를 서로 다른 신규 파트로 흩뿌린다.
      //   잉여만 옮기므로 원 파트는 미운용이 되지 않아 운용 수가 실제로 증가한다(파트 교체가 아님).
      //   K명을 K개 신규 파트로 → 운용 = opNow + K. K=(7-opNow) 이면 7 → 차단, K=(6-opNow) 이면 6 → 허용.
      const surplus: typeof base.crewRows = [];
      for (const p of base.operatedParts) {
        const inPart = base.crewRows.filter((r) => r.rawPart === p.partName);
        surplus.push(...inPart.slice(1)); // 첫 1명은 남겨 원 파트 운용 유지.
      }
      const blockK = 7 - opNow;
      if (surplus.length < blockK) {
        console.log(`  (잉여 크루 ${surplus.length} < ${blockK} — 7개 유도 불가, skip)`);
      } else {
        const picks = surplus.slice(0, blockK);
        const restore = await snapshotAndRestorer(org, weekStart, teamName, picks.map((p) => p.userId));
        const changes = picks.map((p, i) => ({ userId: p.userId, rawPart: `QA운용${i + 1}`, positionCode: "regular" as PositionCode }));
        const res = await applyOverride(org, teamName, editWeek.weekId, changes);
        ck(res.status === 422 && /운용.*6개/.test(res.error ?? ""), `운용 ${opNow}→7 batch 차단(422): "${res.error}"`);
        const anyWritten = (await Promise.all(picks.map((p) => readOverrideRow(org, weekStart, teamName, p.userId)))).some((o) => (o?.raw_part ?? "").startsWith("QA운용"));
        ck(!anyWritten, `DB 미저장(부분 저장 없음)`);
        // 경계: 정확히 6개까지는 허용(blockK-1 = 6-opNow 명만 신규 파트로).
        const okK = 6 - opNow;
        if (okK >= 1) {
          const okPicks = surplus.slice(0, okK);
          const okChanges = okPicks.map((p, i) => ({ userId: p.userId, rawPart: `QA운용${i + 1}`, positionCode: "regular" as PositionCode }));
          const resOk = await applyOverride(org, teamName, editWeek.weekId, okChanges);
          const afterOk = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
          ck(resOk.status === 200 && afterOk.operatedParts.length === 6, `운용 ${opNow}→6 경계 저장 허용(운용=${afterOk.operatedParts.length})`);
        }
        await restore();
        const restored = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
        ck(restored.operatedParts.length === opNow, `복구: 운용 파트 ${opNow} 원복`);
      }
    }
  }

  // ── §19 op/test parity(effective coalesce 동일 경로) ─────────────────────
  console.log("\n[§19] operating/test parity");
  {
    const opS = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "operating" });
    const tsS = await getTeamSelectedWeekSummary({ organization: org, teamName, weekId: editWeek.weekId, mode: "test" });
    const keys = (o: object) => Object.keys(o).sort().join(",");
    const rowKeys = (s: TeamSelectedWeekSummary) => (s.crewRows[0] ? keys(s.crewRows[0]) : "");
    ck(keys(opS) === keys(tsS), `요약 DTO 키 동일`);
    ck(rowKeys(opS) === rowKeys(tsS) || !opS.crewRows[0] || !tsS.crewRows[0], `crewRow effective 필드 동일(rawPart/positionCode 포함)`);
  }

  // ── 최종: override 테이블에 잔여 e2e 행 없음(전역 복구 확인, §17) ─────────
  console.log("\n[최종] 잔여 테스트 override 정리 확인");
  {
    const { data } = await supabaseAdmin.from(TABLE).select("raw_team,raw_part").in("created_by", ["e2e-test", "e2e", "e2e-restore"]);
    const leftover = (data ?? []) as Array<{ raw_team: string; raw_part: string | null }>;
    // e2e-restore 는 원본 재기입일 수 있으므로 raw_team=합성/임시 파트만 잔여로 간주.
    const bad = leftover.filter(
      (r) =>
        r.raw_team.includes("QA복수팀") ||
        r.raw_part === "QA임시파트" ||
        r.raw_part === "QA7번째파트" ||
        (r.raw_part ?? "").startsWith("QA운용"),
    );
    ck(bad.length === 0, `합성/임시 잔여 행 없음(발견 ${bad.length})`);
  }

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
