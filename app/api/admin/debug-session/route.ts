import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";

export async function GET() {
  try {
    const admin = await requireAdmin();
    return Response.json({
      success: true,
      data: {
        userId: admin.userId,
        email: admin.email,
        role: admin.role,
        isActive: admin.isActive,
      },
    });
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
