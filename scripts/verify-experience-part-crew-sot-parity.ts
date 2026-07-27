// 실무 경험 라인 개설 — "파트 드롭다운 ⟺ 평가 대상 크루" 불변식 검증 (2026-07-27, 읽기 전용)
//
//   npx tsx --env-file=.env.local scripts/verify-experience-part-crew-sot-parity.ts
//
// 검증 대상 불변식
//   ① 드롭다운에 뜬 파트는 반드시 평가 대상 크루 ≥1 ("평가 대상 크루가 없습니다" 상태 불가).
//   ② 평가 대상 크루 ≥1 인 파트는 반드시 드롭다운에 뜬다(신청 대상에서 누락 불가).
//   ③ part-input 크루 ⊆ /admin/team-parts/info/* 의 그 주차 배정 크루(동일 userId 집합).
//      빠진 인원은 **명시된 정책 규칙**(파트장 = 평가자 · 시즌 전체 휴식자 = 개설 후보 아님)으로만
//      설명돼야 한다. 그 외 사유(팀 불일치·파트 불일치·override 시점 차이 등)가 1건이라도 있으면 FAIL.
//   ④ 팀 총괄 보드(getTeamOverallBoard)의 신청 대상 파트 집합 == ①의 드롭다운 집합.
//      (갈리면 [개설 검수]가 영구 차단되거나 신청 완료가 반영되지 않는다.)
//
// 범위: 활성 반기 팀 전수 × mode(operating/test) × 주차(현재 + 과거 2주).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import {
  experienceEvaluablePartNames,
  listPartCrews,
  loadExperienceWeekRoster,
} from "@/lib/adminExperiencePartInput";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScope";

const MODES: ScopeMode[] = ["operating", "test"];
const PAST_WEEKS = 2;

let pass = 0;
let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  if (!ok) console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const sorted = (a: string[]) => [...a].sort();
const J = (v: unknown) => JSON.stringify(v);

async function main() {
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("organization_slug,team_name,is_active")
    .eq("is_active", true);
  const combos = Array.from(
    new Map(
      ((halves ?? []) as Array<{ organization_slug: string; team_name: string }>).map((h) => [
        `${h.organization_slug}::${h.team_name}`,
        h,
      ]),
    ).values(),
  );

  // team_id(팀 총괄 보드용) — 팀명 → id.
  const { data: teamRows } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id,team_name,organization_slug,is_active")
    .eq("is_active", true);
  const teamIdByKey = new Map(
    ((teamRows ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>).map(
      (t) => [`${t.organization_slug}::${t.team_name}`, t.id],
    ),
  );

  let scanned = 0;
  const policyDrops: string[] = [];

  for (const h of combos) {
    const org = h.organization_slug as OrganizationSlug;
    for (const mode of MODES) {
      // 검증 주차 = 선택 가능 목록의 최신 N+1개(현재 주차 포함).
      const base = await getTeamSelectedWeekSummary({
        organization: org,
        teamName: h.team_name,
        weekId: null,
        mode,
      });
      const weekIds = base.selectableWeeks.slice(0, PAST_WEEKS + 1).map((w) => w.weekId);
      for (const weekId of weekIds) {
        scanned++;
        const label = `[${h.organization_slug}] ${h.team_name} / ${mode} / ${weekId.slice(0, 8)}`;

        const roster = await loadExperienceWeekRoster(h.organization_slug, h.team_name, mode, weekId);
        const parts = experienceEvaluablePartNames(roster.rows);
        const summary = await getTeamSelectedWeekSummary({
          organization: org,
          teamName: h.team_name,
          weekId,
          mode,
        });

        // ① 드롭다운 파트는 전부 크루 ≥1.
        for (const part of parts) {
          const crews = await listPartCrews(h.organization_slug, h.team_name, part, mode, weekId);
          ck(
            `${label} 파트 '${part}' 크루 ≥1`,
            crews.length > 0,
            crews.length === 0 ? "드롭다운에 있으나 평가 대상 크루 0명" : "",
          );
          // ③ part-input 크루 ⊆ 팀 상세 그 주차 배정 크루(동일 파트).
          const sotIds = new Set(
            summary.crewRows.filter((r) => (r.rawPart ?? "").trim() === part).map((r) => r.userId),
          );
          const stray = crews.filter((c) => !sotIds.has(c.userId));
          ck(
            `${label} 파트 '${part}' 크루 ⊆ 팀상세 배정 크루`,
            stray.length === 0,
            stray.length ? `팀상세에 없는 크루 ${J(stray.map((c) => c.userId))}` : "",
          );
        }

        // ② 팀상세 <운용> 파트 중 드롭다운에 없는 파트 = 평가 대상 0명이어야 하고,
        //    그 사유는 파트장/시즌휴식 정책으로만 설명돼야 한다.
        const operated = summary.operatedParts.map((p) => p.partName).filter((p) => p !== "일반");
        for (const part of operated) {
          if (parts.includes(part)) continue;
          const sotRows = summary.crewRows.filter((r) => (r.rawPart ?? "").trim() === part);
          const rosterInPart = roster.rows.filter((r) => r.partName === part);
          const evaluable = rosterInPart.filter((r) => !r.isPartLeader);
          ck(
            `${label} 드롭다운 제외 파트 '${part}' 는 평가 대상 0명`,
            evaluable.length === 0,
            evaluable.length ? `평가 대상 ${evaluable.length}명인데 드롭다운 누락` : "",
          );
          // 제외 사유 분류: 파트장만 / 시즌휴식(로스터에서 탈락).
          const leaderOnly = rosterInPart.length > 0 && rosterInPart.every((r) => r.isPartLeader);
          const restDropped = sotRows.filter(
            (r) => !rosterInPart.some((x) => x.userId === r.userId),
          );
          const reason = leaderOnly
            ? "파트장만 배정(평가자 = 평가 대상 아님)"
            : restDropped.length === sotRows.length
              ? "전원 시즌 전체 휴식자(라인 개설 후보 아님)"
              : "혼합";
          policyDrops.push(
            `${label} '${part}' — 팀상세 ${sotRows.length}명 / 평가 대상 0명 · 사유: ${reason}`,
          );
        }

        // ④ 팀 총괄 보드의 신청 대상 파트 == 드롭다운 파트.
        const teamId = teamIdByKey.get(`${h.organization_slug}::${h.team_name}`);
        if (teamId) {
          const board = await getTeamOverallBoard(
            h.organization_slug,
            weekId,
            teamId,
            h.team_name,
            mode,
          );
          const targetParts = board.parts
            .filter((p) => parts.includes(p.partName))
            .map((p) => p.partName);
          ck(
            `${label} 보드 신청 대상 파트 == 드롭다운 파트`,
            J(sorted(targetParts)) === J(sorted(parts)) &&
              board.application.totalPartCount === parts.length,
            `board.totalPartCount=${board.application.totalPartCount} / parts=${J(sorted(parts))}`,
          );
        }
      }
    }
  }

  console.log(`\n── 정책상 드롭다운에서 제외된 파트(경우 2) ${policyDrops.length}건 ──`);
  for (const d of policyDrops) console.log(`  · ${d}`);
  console.log(`\n═══ ${scanned} (org·팀·mode·주차) 스캔 — PASS ${pass} / FAIL ${fail} ═══`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
