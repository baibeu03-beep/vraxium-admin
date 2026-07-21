/**
 * 팀 내역(활동 관리 §1) 상단 요약 도움말 등록.
 *   · 신규 키: admin.teamParts.info.summary.totalParts (전체 파트 수).
 *   · 기존 키(clubCount·totalTeams)는 의미가 "현재 접속 시점·전 조직" 으로 확장됐으므로,
 *     내용이 비어 있을 때만 기본 문구를 채운다(관리자 작성 내용은 덮어쓰지 않음).
 *
 *   npx tsx --env-file=.env.local scripts/apply-team-parts-info-summary-help.ts
 */
import { getHelpContent, upsertHelpContent } from "@/lib/adminPageHelpData";

const TOTAL_PARTS_KEY = "admin.teamParts.info.summary.totalParts";
const CLUB_KEY = "admin.teamParts.info.summary.clubCount";
const TEAM_KEY = "admin.teamParts.info.summary.totalTeams";

const TOTAL_PARTS_TEXT = [
  "현재 접속 시점 기준, 전체 클럽(엥크레·오랑캐·팔랑크스)의 현재 반기 활성 팀에 등록된 파트의 총개수입니다.",
  "",
  "· 상단 '해당 시기' 선택과 무관하게 항상 현재 시점 현황을 보여줍니다(과거 반기를 선택해도 값이 바뀌지 않습니다).",
  "· 화면에 보이는 일부 행을 세는 것이 아니라 원천 데이터(cluster4_team_parts)를 파트 ID 기준으로 중복 없이 집계합니다.",
  "· 모드(운영/QA 테스트)에 따라 대상 팀 범위가 달라지며, 같은 시점·같은 모드에서는 어느 조직 화면에서도 동일한 값입니다.",
].join("\n");

const CLUB_TEXT = [
  "현재 접속 시점 기준, 현재 반기에 활성 팀이 1개 이상인 클럽(조직)의 총개수입니다.",
  "",
  "· 상단 '해당 시기' 선택과 무관하게 항상 현재 시점 현황을 보여줍니다.",
  "· 전체 클럽(엥크레·오랑캐·팔랑크스) 기준이며, 개별 조직 화면에서도 동일한 값입니다.",
].join("\n");

const TEAM_TEXT = [
  "현재 접속 시점 기준, 전체 클럽의 현재 반기 활성 팀 총개수입니다.",
  "",
  "· 상단 '해당 시기' 선택과 무관하게 항상 현재 시점 현황을 보여줍니다.",
  "· 화면에 보이는 행이 아니라 원천 데이터를 팀 ID 기준으로 중복 없이 집계합니다.",
].join("\n");

async function seedIfEmpty(key: string, text: string): Promise<void> {
  const existing = await getHelpContent(key);
  if (existing && existing.trim() !== "") {
    console.log(`skip  ${key} (이미 내용 있음, 길이=${existing.length})`);
    return;
  }
  await upsertHelpContent(key, text);
  console.log(`seed  ${key} (${text.length}자)`);
}

async function main() {
  // 신규 키 — 항상 보장(비어 있으면 채움).
  await seedIfEmpty(TOTAL_PARTS_KEY, TOTAL_PARTS_TEXT);
  // 기존 키 — 비어 있을 때만(관리자 작성 내용 보존).
  await seedIfEmpty(CLUB_KEY, CLUB_TEXT);
  await seedIfEmpty(TEAM_KEY, TEAM_TEXT);
  console.log("done.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
