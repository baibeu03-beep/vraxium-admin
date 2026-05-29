import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// 프론트 프록시(vraxium/lib/adminBaseUrl.ts)가 admin 서버를 식별하는 데 사용.
// 포트 순서나 실행 순서에 영향받지 않도록 localhost:{3000,3001,3002}/api/health 를
// 차례로 probe 한 뒤 service === "vraxium-admin" 인 응답을 admin backend 로 채택한다.
export function GET() {
  return NextResponse.json({ ok: true, service: "vraxium-admin" });
}
