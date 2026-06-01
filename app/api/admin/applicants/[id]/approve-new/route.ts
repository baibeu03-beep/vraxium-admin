// app/api/admin/applicants/[id]/approve-new/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { randomUUID } from "crypto";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: applicantId } = await params;

  const { data: applicant, error: applicantError } = await supabaseAdmin
    .from("applicants")
    .select("id, email, provider, status, name")
    .eq("id", applicantId)
    .single();

  if (applicantError || !applicant) {
    return NextResponse.json({ error: "Applicant not found" }, { status: 404 });
  }

  if (applicant.status !== "pending") {
    return NextResponse.json(
      { error: "Applicant is not pending" },
      { status: 400 },
    );
  }

  if (!applicant.email) {
    return NextResponse.json(
      { error: "Applicant email is required to create a user profile" },
      { status: 400 },
    );
  }

  const newUserId = randomUUID();
  const fallbackName =
    applicant.name && applicant.name !== "kakao-user"
      ? applicant.name
      : applicant.email.split("@")[0];

  const { error: userInsertError } = await supabaseAdmin
    .from("users")
    .insert({
      id: newUserId,
    });

  if (userInsertError) {
    console.error("approve-new userInsertError", userInsertError);
    return NextResponse.json(
      {
        step: "insert_users",
        error: userInsertError.message ?? "Failed to create user",
        details: userInsertError,
      },
      { status: 500 },
    );
  }

  const now = new Date();
  const dow = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const activityStartedAt = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}T00:00:00+09:00`;

  const { data: newProfile, error: insertError } = await supabaseAdmin
    .from("user_profiles")
    .insert({
      user_id: newUserId,
      display_name: fallbackName,
      auth_email: applicant.email,
      contact_email: applicant.email,
      status: "active",
      growth_status: "active",
      activity_started_at: activityStartedAt,
    })
    .select("user_id")
    .single();

  if (insertError || !newProfile) {
    console.error("approve-new insertError", insertError);
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    return NextResponse.json(
      {
        step: "insert_user_profile",
        error: insertError?.message ?? "Failed to create user profile",
        details: insertError,
      },
      { status: 500 },
    );
  }

  const { error: applicantUpdateError } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "approved",
      linked_user_id: newProfile.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", applicantId);

  if (applicantUpdateError) {
    console.error("approve-new applicantUpdateError", applicantUpdateError);
    const { error: rollbackProfileError } = await supabaseAdmin
      .from("user_profiles")
      .delete()
      .eq("user_id", newUserId);
    if (rollbackProfileError) {
      console.error(
        "approve-new rollback user_profiles delete failed",
        rollbackProfileError,
      );
    }
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    return NextResponse.json(
      {
        step: "update_applicant",
        error: applicantUpdateError.message,
        details: applicantUpdateError,
      },
      { status: 500 },
    );
  }

  // 신규 유저 snapshot 최초 생성(쓰기 시점). uws 가 아직 없으면 빈 카드로 저장 → 조회 시
  // miss→fallback(실시간 계산) 대신 hit 으로 응답. best-effort — 실패해도 승인은 유지.
  try {
    await recomputeAndStoreWeeklyCardsSnapshot(newProfile.user_id);
  } catch (snapErr) {
    console.warn("approve-new initial snapshot create failed (non-fatal)", {
      userId: newProfile.user_id,
      message: snapErr instanceof Error ? snapErr.message : String(snapErr),
    });
  }

  return NextResponse.json({
    ok: true,
    linked_user_id: newProfile.user_id,
  });
}
