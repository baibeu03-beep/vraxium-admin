import IntegratedAdminSection from "@/components/admin/IntegratedAdminSection";

export default function IntegratedLineOpeningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <IntegratedAdminSection helpKey="admin.lineOpening.filter.club">
      {children}
    </IntegratedAdminSection>
  );
}
