// [오픈 확인] 재실행 타임라인 로더 — 액트 시점 경계 판정(weekOpenGate.isActOpenAtTime)의 서버 원천.
//
//   구조: 최신본/마스터 스위치 = 기존 SoT `cluster4_week_opening_configs`(loadWeekOpeningConfig 와
//   동일 select). 버전 이력 = 신규 `cluster4_week_opening_config_versions`(append-only).
//   버전 테이블 미적용(42P01)이면 timelineAvailable=false → 호출부가 latestConfig(최신 config)로
//   폴백 = 오늘 동작(무회귀·graceful degradation). recognition 컬럼 probe(loadRecognitionColumnsAvailable)
//   와 동일한 방어 패턴.
//
//   ⚠ mode(operating/test)·actAsTestUserId·demoUserId 로 분기하지 않는다 — (weekId, org) 만 입력.
//     일반/테스트/개별 경로가 전부 이 함수를 공유해 동일 타임라인·동일 판정을 보장한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import type { SavedConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import type { ActOpenTimeline, TimelineVersion } from "@/lib/weekOpenGate";

export type OpeningConfigVersion = TimelineVersion & {
  versionNo: number;
  createdBy: string | null;
  createdAt: string;
};

export type WeekOpeningTimeline = ActOpenTimeline & {
  versions: OpeningConfigVersion[];
};

export async function loadWeekOpeningTimeline(
  weekId: string,
  organization: OrganizationSlug,
): Promise<WeekOpeningTimeline> {
  // 최신본 + 마스터 스위치 — 기존 loadWeekOpeningConfig 와 동일 원천/컬럼(라인 소비처와 결과 일치).
  const { data: parent, error: pErr } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("config,open_confirmed")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .maybeSingle();
  const pRow = pErr ? null : (parent as { config: SavedConfig | null; open_confirmed: boolean } | null);
  const openConfirmed = pRow?.open_confirmed === true;
  const latestConfig = pRow?.config ?? null;

  // 버전 이력 — effectiveFromMs ASC. 테이블 미적용(42P01 등)이면 graceful: timelineAvailable=false.
  const { data: vData, error: vErr } = await supabaseAdmin
    .from("cluster4_week_opening_config_versions")
    .select("version_no,config,effective_from,created_by,created_at")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .order("effective_from", { ascending: true })
    .order("version_no", { ascending: true });
  if (vErr) {
    return { openConfirmed, latestConfig, versions: [], timelineAvailable: false };
  }
  const versions: OpeningConfigVersion[] = (
    (vData ?? []) as Array<{
      version_no: number;
      config: SavedConfig | null;
      effective_from: string;
      created_by: string | null;
      created_at: string;
    }>
  ).map((r) => ({
    versionNo: r.version_no,
    config: r.config ?? null,
    effectiveFromMs: Date.parse(r.effective_from),
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
  }));
  return { openConfirmed, latestConfig, versions, timelineAvailable: true };
}
