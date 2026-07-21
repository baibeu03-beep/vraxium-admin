/**
 * 클럽 목록(상위 페이지 `/admin/team-parts/info`) 표 컬럼 도움말 등록.
 *   · 모든 값은 현재 접속 시점 기준(상세의 `해당 시기` 선택과 무관).
 *   · 비어 있을 때만 기본 문구를 채운다(관리자 작성 내용 보존).
 *
 *   npx tsx --env-file=.env.local scripts/apply-club-summary-help.ts
 */
import { getHelpContent, upsertHelpContent } from "@/lib/adminPageHelpData";

const NS = "admin.teamPartsInfoClubs.column";
const TEXTS: Record<string, string[]> = {
  [`${NS}.club`]: [
    "현재 시점에 유효한 클럽(조직)입니다. 클럽명을 누르면 해당 클럽 상세 페이지로 이동합니다.",
    "· 각 클럽당 한 행이며, 모든 수치는 현재 접속 시점 기준입니다.",
  ],
  [`${NS}.staff`]: [
    "현재 이 클럽에 소속된 운영진 인원 수입니다.",
    "",
    "· 운영진 = 팀장 수 + 앰배서더.",
    "· 사람(고유 userId) 기준으로 세며, 상단 '해당 시기'와 무관하게 현재 시점 기준입니다.",
  ],
  [`${NS}.team`]: [
    "이 클럽의 팀장(운영진 중 팀장 역할) 인원 수입니다.",
    "",
    "· 팀 개수(엔터티)가 아니라 '팀장 인원 수'입니다. 운영진 = 팀장 수 + 앰배서더.",
    "· 한 사람이 여러 팀의 팀장을 맡아도 사람 수 기준으로 1명입니다.",
    "· 상단 '해당 시기'와 무관하게 현재 접속 시점 기준입니다.",
  ],
  [`${NS}.ambassador`]: [
    "현재 이 클럽에 소속된 앰배서더 인원 수입니다.",
    "· 고유 userId 기준(중복 역할·조인 제거). 종료·탈퇴·비활성 소속은 제외됩니다.",
  ],
  [`${NS}.clubbing`]: [
    "현재 이 클럽에 소속된 크루(클러빙) 인원 수입니다.",
    "",
    "· 클러빙 = 정규 크루 + 심화 크루.",
    "· '주차 휴식' 상태의 크루도 현재 소속이므로 포함합니다(그 주 활동만 쉬는 상태).",
    "· 완전 탈퇴·소속 종료·삭제된 크루는 제외됩니다. 고유 userId 기준.",
  ],
  [`${NS}.regular`]: [
    "현재 이 클럽의 정규 크루 인원 수입니다.",
    "· 주차 휴식 크루 포함. 고유 userId 기준(여러 파트·행이어도 1명).",
  ],
  [`${NS}.advanced`]: [
    "현재 이 클럽의 심화 크루 인원 수입니다.",
    "",
    "· 심화 크루 = 파트장 수 + 에이전트 수.",
    "· 주차 휴식 크루 포함. 고유 userId 기준.",
  ],
  [`${NS}.part`]: [
    "현재 시점에 유효한 이 클럽 산하 파트 수입니다.",
    "· 현재 반기 활성 팀 산하 파트를 고유 partId 기준으로 셉니다(종료·삭제·중복 제외).",
  ],
  [`${NS}.partLeader`]: [
    "현재 이 클럽의 파트장 인원 수입니다.",
    "· 사람(고유 userId) 기준 — 한 명이 여러 파트를 맡아도 1명으로 셉니다(보직 수 아님).",
  ],
  [`${NS}.agent`]: [
    "현재 이 클럽의 에이전트 인원 수입니다.",
    "· 고유 userId 기준(중복 소속·조인 제거). 종료·삭제·비활성 역할 제외.",
  ],
};

async function seedIfEmpty(key: string, text: string): Promise<void> {
  const existing = await getHelpContent(key);
  if (existing && existing.trim() !== "") {
    console.log(`skip  ${key} (이미 내용 있음)`);
    return;
  }
  await upsertHelpContent(key, text);
  console.log(`seed  ${key} (${text.length}자)`);
}

async function main() {
  for (const [key, lines] of Object.entries(TEXTS)) {
    await seedIfEmpty(key, lines.join("\n"));
  }
  console.log("done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
