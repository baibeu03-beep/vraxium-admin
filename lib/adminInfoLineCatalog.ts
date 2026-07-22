// 실무 정보(info) 라인 카탈로그 — **모든 info 소비 화면의 단일 SoT**.
//
// 제품 계약 (2026-07-22 확정):
//   실무 정보의 활동유형은 **고정 9종**이다(wisdom·essay·infodesk·calendar·forum·session·
//   practical_lecture·community·etc_a). 고객 앱 카드와 전 운영 체계가 이 9개 id 를 전제로 굳어져 있다.
//   /admin/lines/register 의 info 등록은 **신규 라인을 만드는 기능이 아니라**, 그 9종 각각에
//     · 정식 라인명   · 정식 라인 코드   · 적용 조직   · 포인트 설정   · 활성 상태
//   를 연결하는 **원장(metadata ledger)** 이다.
//   → info 등록으로 activity_types 행이 생기지 않는다. 이 카탈로그도 9행을 넘지 않는다.
//
// 이 모듈이 존재하는 이유(등록이 라인을 만들지 않는데도):
//   종전에는 8곳이 각자 activity_types 를 조회하고 표시 순서를 3벌 복붙했으며, 주차 상세는
//   activity_types 배열과 line_registrations 배열을 **index 로 짝지어** 라인명을 붙였다(등록 순서가
//   바뀌면 9개 이름이 통째로 밀리는 구조). 라인 유니버스·표시 순서·등록 원장 조인을 여기 한 곳으로
//   모아 그 발산을 없앤다.
//
// org 의 의미(중요):
//   조직은 **행을 늘리거나 줄이지 않는다**. 9종은 어느 조직에서나 9종이다. 조직은 "그 9행에 어떤
//   등록 원장의 라인명/코드를 붙여 보여줄지"만 고른다(조직 전용 등록 > common 등록 > 원장 없음).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

// 고정 9종 — 표시 순서 정본(위즈덤 → 에세이 → 인포데스크 → 캘린더 → 포럼 → 세션 → 아카데미 →
//   커뮤니티 → 기타A). 종전 PracticalInfoManager.PREFERRED_TAB_ORDER /
//   adminCluster4InfoLineResults.PREFERRED_ORDER / adminTeamPartsInfoLineOpeningData.INFO_PREFERRED_ORDER
//   3중 복제를 이 상수로 통합했다.
//   ⚠ 이 배열이 곧 실무 정보의 실행 유니버스다. 여기 없는 activity_types 행은 어떤 info 화면에도
//     나타나지 않는다(DB 에 이질적인 practical_info 행이 생겨도 목록이 10개로 늘지 않는다).
export const INFO_ACTIVITY_TYPE_IDS = [
  "wisdom",
  "essay",
  "infodesk",
  "calendar",
  "forum",
  "session",
  "practical_lecture",
  "community",
  "etc_a",
] as const;

export type InfoActivityTypeId = (typeof INFO_ACTIVITY_TYPE_IDS)[number];

const ORDER: readonly string[] = INFO_ACTIVITY_TYPE_IDS;
const ORDER_INDEX = new Map(INFO_ACTIVITY_TYPE_IDS.map((id, i) => [id as string, i]));

export function isInfoActivityTypeId(value: unknown): value is InfoActivityTypeId {
  return typeof value === "string" && ORDER_INDEX.has(value);
}

export type InfoLineCatalogItem = {
  // 라인 ID = activity_types.id (고정 9종 중 하나).
  //   practical-info 탭 · team-parts/info/weeks · 주차 오픈 설정 키 · 개설 FK · 포인트 config_key ·
  //   고객 카드가 전부 이 동일 값을 쓴다.
  lineId: string;
  activityTypeId: string; // lineId 와 동일 값(호출부 가독성용 alias)
  // 표시 라인명 = activity_types.name(정본). 등록 원장 이름으로 덮지 않는다 — 고객 앱이 이 라벨을
  //   하드코딩으로 갖고 있고 과거 데이터/FK 가 이 값에 매달려 있다(예: etc_a="기타A", 원장은 "기타").
  lineName: string;
  lineCode: string | null; // activity_types.line_code(정본)
  // 등록 원장(line_registrations, hub='info')이 이 활동유형에 부여한 정식 라인명/코드. 미등록이면 null.
  registeredLineName: string | null;
  registeredLineCode: string | null;
  registrationId: string | null;
  // 표시에 채택된 등록 원장의 소속 조직('common' | org). 미등록이면 null.
  registeredOrganizationSlug: string | null;
  sortIndex: number;
};

type ActivityTypeRow = {
  id: string;
  name: string | null;
  line_code: string | null;
};

type RegistrationRow = {
  id: string;
  line_name: string | null;
  line_code: string | null;
  organization_slug: string | null;
  point_activity_type_id: string | null;
  is_active: boolean | null;
};

/**
 * 실무 정보 라인 목록 — **항상 고정 9종**(활성 activity_types 기준). 표시 순서 확정.
 *
 * @param organization 조직 진입이면 slug, 통합 진입이면 null. 행 수에는 영향이 없고,
 *                     각 행에 붙는 등록 원장(라인명/코드)만 org 우선순위로 고른다.
 */
export async function listInfoLineCatalog(
  organization: OrganizationSlug | null,
): Promise<InfoLineCatalogItem[]> {
  const [atRes, regRes] = await Promise.all([
    supabaseAdmin
      .from("activity_types")
      .select("id,name,line_code")
      .eq("cluster_id", "practical_info")
      .eq("is_active", true)
      .in("id", [...INFO_ACTIVITY_TYPE_IDS]),
    supabaseAdmin
      .from("line_registrations")
      .select("id,line_name,line_code,organization_slug,point_activity_type_id,is_active")
      .eq("hub", "info"),
  ]);

  if (atRes.error) {
    console.warn("[infoLineCatalog] activity_types unavailable:", atRes.error.message);
    return [];
  }
  const typeById = new Map<string, ActivityTypeRow>(
    ((atRes.data ?? []) as ActivityTypeRow[]).map((t) => [t.id, t]),
  );

  // 등록 원장 조회 실패(테이블/컬럼 미적용 등)는 치명적이지 않다 — 정본 이름만으로 graceful degrade.
  if (regRes.error) {
    console.warn("[infoLineCatalog] line_registrations unavailable:", regRes.error.message);
  }
  const regs = ((regRes.error ? [] : regRes.data) ?? []) as RegistrationRow[];

  // 활동유형별 후보 등록행 — 활성 + 조직 미지정(NULL) 제외.
  //   organization 지정 시 그 조직 또는 common 만, 통합(null)이면 org 가 있는 전부.
  const candidates = new Map<string, RegistrationRow[]>();
  for (const r of regs) {
    const act = r.point_activity_type_id;
    if (!act || !ORDER_INDEX.has(act)) continue;
    if (r.is_active === false) continue;
    const org = r.organization_slug;
    if (org == null) continue;
    if (organization != null && org !== "common" && org !== organization) continue;
    const list = candidates.get(act);
    if (list) list.push(r);
    else candidates.set(act, [r]);
  }

  const items: InfoLineCatalogItem[] = [];
  for (const id of INFO_ACTIVITY_TYPE_IDS) {
    const t = typeById.get(id);
    if (!t) continue; // 정본 행이 비활성/부재 — 방어적으로 건너뛴다(정상 운영에선 9행 모두 존재).
    // 표시 원장 1행 — 조직 전용 > common. 동률이면 line_code ASC(결정적).
    const picked = (candidates.get(id) ?? [])
      .slice()
      .sort((a, b) => {
        const aOrg = organization != null && a.organization_slug === organization ? 0 : 1;
        const bOrg = organization != null && b.organization_slug === organization ? 0 : 1;
        if (aOrg !== bOrg) return aOrg - bOrg;
        return (a.line_code ?? "").localeCompare(b.line_code ?? "");
      })[0] ?? null;

    items.push({
      lineId: id,
      activityTypeId: id,
      lineName: t.name?.trim() || id,
      lineCode: t.line_code,
      registeredLineName: picked?.line_name?.trim() || null,
      registeredLineCode: picked?.line_code ?? null,
      registrationId: picked?.id ?? null,
      registeredOrganizationSlug: picked?.organization_slug ?? null,
      sortIndex: ORDER_INDEX.get(id)!,
    });
  }

  items.sort((a, b) => a.sortIndex - b.sortIndex);
  return items;
}

// 라인 ID 목록만 필요할 때(오픈 게이트 맵 등).
export async function listInfoLineIds(
  organization: OrganizationSlug | null,
): Promise<string[]> {
  return (await listInfoLineCatalog(organization)).map((l) => l.lineId);
}

// 표시 순서 비교자 — 카탈로그를 거치지 않고 id 배열만 정렬해야 하는 호출부용.
export function compareInfoLineIds(a: string, b: string): number {
  const na = ORDER_INDEX.get(a) ?? ORDER.length;
  const nb = ORDER_INDEX.get(b) ?? ORDER.length;
  return na - nb || a.localeCompare(b);
}
