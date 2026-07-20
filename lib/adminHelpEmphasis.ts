// 어드민 "도움말" 버튼(AdminHelp)의 강조("안내 있음") 공통 로직 — 순수/클라이언트 헬퍼.
//   · 도움말 "내용 존재 여부"와 "열람 여부"만 다룬다. 본문/권한/API 응답 의미는 건드리지 않는다
//     (요구: 내용/응답 의미 불변 — 존재·열람만으로 UI 강조).
//   · org/mode/actAsTestUserId/demoUserId 로 갈라지지 않는다 — /api/admin/help 는 path(키)만 읽고
//     mode/org 를 무시하므로(=본문 동일), 여기서도 키만으로 판단한다. 일반/테스트 동일 로직.
//   · 조회는 도움말 모달과 "같은" GET /api/admin/help(같은 DTO: data.content / data.canEdit).

/** 표시할 실제 내용이 있는가(공백만 = 없음). */
export function hasHelpContent(content: string | null | undefined): boolean {
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * 도움말 내용 식별자(버전). 내용이 바뀌면 값이 바뀌어 "신규 안내"로 다시 강조된다.
 *   · djb2 해시 → base36(짧고 결정적). 빈 내용은 "" (버전 없음 = 강조 대상 아님).
 *   · 저장소 키에만 쓰는 표시용 식별자 — 보안/충돌 민감도 없음.
 */
export function helpContentVersion(content: string | null | undefined): string {
  if (!hasHelpContent(content)) return "";
  const s = (content as string).trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const SEEN_PREFIX = "admin-help-seen";

/** 열람 여부 저장 키 — 페이지키 + 내용버전. 내용이 바뀌면 키가 바뀌어 다시 신규로 인식. */
export function helpSeenStorageKey(pageKey: string, version: string): string {
  return `${SEEN_PREFIX}:${pageKey}:${version}`;
}

/** 이 페이지의 이 버전 도움말을 이미 열람했는가. 내용 없음(version="")은 강조 대상 아님 → true 취급. */
export function readHelpSeen(pageKey: string, version: string): boolean {
  if (!version) return true;
  try {
    return window.localStorage.getItem(helpSeenStorageKey(pageKey, version)) === "1";
  } catch {
    // localStorage 접근 불가(프라이빗 모드 등) — "안 봤음"으로 두되 기록만 실패(기능 무영향).
    return false;
  }
}

/** 열람 표시(같은 페이지·같은 내용 버전에선 다시 강조하지 않도록). */
export function markHelpSeen(pageKey: string, version: string): void {
  if (!version) return;
  try {
    window.localStorage.setItem(helpSeenStorageKey(pageKey, version), "1");
  } catch {
    /* 저장 실패는 무시 — 강조가 계속돼도 기능엔 영향 없음. */
  }
}

export type HelpMeta = {
  /** 저장된 도움말 본문(빈 문자열 포함). */
  content: string;
  /** 편집/저장 권한(owner/admin). GET 응답의 canEdit. */
  canEdit: boolean;
};

// 페이지키 → 도움말 메타 캐시(모듈 스코프, 세션 지속). AdminHelp mount 마다 재조회하지 않도록.
//   · 요소 돋보기(AdminHelpIconButton)의 캐시와 별개(그쪽은 helpKey·content 전용) — 여기선 canEdit 도 필요.
const metaCache = new Map<string, HelpMeta>();
const metaInflight = new Map<string, Promise<HelpMeta>>();

/** 도움말 메타(내용+권한) 1회 조회 + 캐시/dedup. 실패는 조용히 빈 값(강조가 기능을 막지 않음). */
export async function fetchHelpMeta(pageKey: string): Promise<HelpMeta> {
  const cached = metaCache.get(pageKey);
  if (cached) return cached;
  const existing = metaInflight.get(pageKey);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch(`/api/admin/help?path=${encodeURIComponent(pageKey)}`, {
        cache: "no-store",
      });
      const json = await res.json();
      const content =
        res.ok && json?.success && typeof json.data?.content === "string" ? json.data.content : "";
      const canEdit = typeof json?.data?.canEdit === "boolean" ? json.data.canEdit : false;
      const meta: HelpMeta = { content, canEdit };
      metaCache.set(pageKey, meta);
      return meta;
    } catch {
      return { content: "", canEdit: false };
    } finally {
      metaInflight.delete(pageKey);
    }
  })();
  metaInflight.set(pageKey, p);
  return p;
}

/** 편집/저장 후 최신 내용을 다시 판단하도록 캐시 무효화. */
export function invalidateHelpMeta(pageKey: string): void {
  metaCache.delete(pageKey);
  metaInflight.delete(pageKey);
}
