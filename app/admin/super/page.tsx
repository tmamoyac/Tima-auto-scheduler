import { SuperAdminContent } from "./SuperAdminContent";

export const dynamic = "force-dynamic";

export default function SuperAdminPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Super Admin</h1>
      <p className="text-sm text-gray-600 mb-6">
        Manage programs and users, activate/deactivate accounts, and reset passwords.
      </p>
      <SuperAdminContent />
    </div>
  );
}
