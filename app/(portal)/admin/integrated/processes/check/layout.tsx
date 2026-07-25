import IntegratedAdminSection from "@/components/admin/IntegratedAdminSection";

export default function IntegratedProcessCheckLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <IntegratedAdminSection helpKey="admin.processCheck.filter.club">
      {children}
    </IntegratedAdminSection>
  );
}
