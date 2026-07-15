/**
 * 검증: 프로세스 체크 상태창1(팀별) 완료 판정 == 하위 액트 완료 집계(summary) 일치.
 *   npx tsx --env-file=.env.local scripts/verify-process-check-status-banner.ts
 *
 * 재현 사례: 26년 여름 2주차 · 운영(T) 팀(phalanx) · 실무 경험. 팀 배너 isAllCompleted 가
 *   그 팀 team_all 하위 집계(summary.isAllCompleted)와 일치해야 한다(더 이상 하드코딩 false 아님).
 */
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

const ORG = "phalanx";
const TEAM_ID = "13e60f37-152c-4e53-8d65-f633cc48d81c"; // 운영(T)
const WEEK = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-summer W2

async function main() {
  // ── 재현 사례: 운영(T) 실무 경험, mode=test, team_all ──
  const board = await getProcessCheckBoard("experience", ORG, TEAM_ID, "test", "team_all", null, WEEK);
  const t = board.teams.find((x) => x.teamId === TEAM_ID);
  const s = board.summary;
  console.log(`[운영(T)/실무경험/W2] banner.isAllCompleted=${t?.isAllCompleted} · summary.isAllCompleted=${s.isAllCompleted} · actTotal=${s.actTotal} · actCompleted=${s.actCompleted} · actApplied=${s.actApplied}`);
  ck("① 배너 존재(팀 목록에 운영(T) 포함)", !!t);
  ck("② summary SoT: isAllCompleted == (actTotal>0 && actCompleted==actTotal)", s.isAllCompleted === (s.actTotal > 0 && s.actCompleted === s.actTotal), { total: s.actTotal, completed: s.actCompleted });
  ck("③ ★배너 == 하위 액트 완료(team_all summary) — 하드코딩 false 제거", t?.isAllCompleted === s.isAllCompleted, { banner: t?.isAllCompleted, summary: s.isAllCompleted });
  if (s.actTotal > 0 && s.actCompleted === s.actTotal) ck("③' 전부 완료면 배너=체크 완료(true)", t?.isAllCompleted === true);

  // ── 전 팀 교차검증: 각 팀 배너 == 그 팀 team_all 하위 집계 ──
  for (const team of board.teams) {
    const b2 = await getProcessCheckBoard("experience", ORG, team.teamId, "test", "team_all", null, WEEK);
    const bannerFromList = board.teams.find((x) => x.teamId === team.teamId)?.isAllCompleted;
    ck(`④ [${team.teamName}] 배너==team_all summary (total=${b2.summary.actTotal} done=${b2.summary.actCompleted})`, bannerFromList === b2.summary.isAllCompleted, { banner: bannerFromList, summary: b2.summary.isAllCompleted });
  }

  // ── 회귀: 비팀 허브(info) summary 경로 무변경(정상 계산) ──
  const info = await getProcessCheckBoard("info", ORG, null, "test", null, null, WEEK);
  ck("⑤ info(비팀) summary SoT 정상", info.summary.isAllCompleted === (info.summary.actTotal > 0 && info.summary.actCompleted === info.summary.actTotal), { total: info.summary.actTotal, completed: info.summary.actCompleted });
  ck("⑤ info teams 빈 배열(비팀 허브)", info.teams.length === 0);

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
