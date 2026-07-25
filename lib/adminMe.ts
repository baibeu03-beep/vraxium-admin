import { requireAdmin, type AdminRole } from "@/lib/adminAuth";
import { resolveDisplayName } from "@/lib/displayNameResolver";

// 로그인된 관리자 본인 정보 DTO.
//   - 관리자 이름(displayName)의 SoT 는 user_profiles.display_name 이다.
//     (계정 관리 화면이 생성/수정 시 같은 컬럼을 쓰므로 별도 컬럼/테이블을 만들지 않는다.)
//   - displayName 은 표시용 부가 정보 — 프로필이 없거나 조회에 실패해도
//     인증/권한에는 영향을 주지 않는다(null 반환, 프론트에서 "관리자" fallback).
export type AdminMeDto = {
  userId: string;
  email: string | null;
  role: AdminRole;
  isActive: true;
  displayName: string | null;
};

export async function loadAdminDisplayName(
  userId: string,
): Promise<string | null> {
  try {
    return await resolveDisplayName(userId);
  } catch (error) {
    console.error("[loadAdminDisplayName] user_profiles lookup failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getAdminMe(): Promise<AdminMeDto> {
  const admin = await requireAdmin();
  const displayName = await loadAdminDisplayName(admin.userId);
  return { ...admin, displayName };
}
