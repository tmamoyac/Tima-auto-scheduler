"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";

type User = {
  id: string;
  email: string;
  created_at: string;
  program_id: string | null;
  program_name: string;
  role: string | null;
  is_active: boolean;
};

type Program = {
  id: string;
  name: string;
  is_active?: boolean;
  default_academic_year?: { id: string; start_date: string; end_date: string } | null;
};

function formatYearRange(start: string, end: string): string {
  if (!start || !end) return "";
  const s = new Date(start + "T12:00:00");
  const e = new Date(end + "T12:00:00");
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function SuperAdminContent() {
  const [users, setUsers] = useState<User[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createProgramId, setCreateProgramId] = useState("");
  const [createRole, setCreateRole] = useState("director");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [setPasswordUserId, setSetPasswordUserId] = useState<string | null>(null);
  const [setPasswordValue, setSetPasswordValue] = useState("");
  const [setPasswordSubmitting, setSetPasswordSubmitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [resettingPasswordUserId, setResettingPasswordUserId] = useState<string | null>(null);

  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editProgramId, setEditProgramId] = useState("");
  const [editRole, setEditRole] = useState("director");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [showCreateProgram, setShowCreateProgram] = useState(false);
  const [createProgramName, setCreateProgramName] = useState("");
  const [createProgramStartDate, setCreateProgramStartDate] = useState("");
  const [createProgramEndDate, setCreateProgramEndDate] = useState("");
  const [createProgramSubmitting, setCreateProgramSubmitting] = useState(false);
  const [createProgramError, setCreateProgramError] = useState<string | null>(null);

  const [editYearOpen, setEditYearOpen] = useState(false);
  const [editYearProgramId, setEditYearProgramId] = useState("");
  const [editYearId, setEditYearId] = useState("");
  const [editYearStart, setEditYearStart] = useState("");
  const [editYearEnd, setEditYearEnd] = useState("");
  const [editYearSaving, setEditYearSaving] = useState(false);
  const [editYearError, setEditYearError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const [usersRes, programsRes] = await Promise.all([
        apiFetch("/api/super-admin/users", { signal: controller.signal }),
        apiFetch("/api/super-admin/programs", { signal: controller.signal }),
      ]);
      clearTimeout(timeout);

      if (!usersRes.ok) {
        const body = await usersRes.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Users: ${usersRes.status}`);
      }
      if (!programsRes.ok) {
        const body = await programsRes.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Programs: ${programsRes.status}`);
      }
      const [u, p] = await Promise.all([usersRes.json(), programsRes.json()]);
      setUsers(u);
      setPrograms(p);
    } catch (e) {
      if (e instanceof Error) {
        if (e.name === "AbortError") {
          setError("Request timed out. Check that SUPABASE_SERVICE_ROLE_KEY is set in .env.local.");
        } else {
          setError(e.message);
        }
      } else {
        setError("Failed to load");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (showCreateProgram) {
      const y = new Date().getUTCFullYear();
      setCreateProgramStartDate(`${y}-07-01`);
      setCreateProgramEndDate(`${y + 1}-06-30`);
    }
  }, [showCreateProgram]);

  const handleToggleActive = async (user: User) => {
    if (!user.program_id) return;
    setActionMsg(null);
    try {
      const res = await apiFetch(`/api/super-admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !user.is_active }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setActionMsg(`User ${user.is_active ? "deactivated" : "activated"}.`);
      fetchData();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleResetPassword = async (user: User) => {
    setActionMsg(null);
    setResettingPasswordUserId(user.id);
    try {
      const res = await apiFetch(`/api/super-admin/users/${user.id}/reset-password`, {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed");
      setActionMsg("Reset email sent.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setResettingPasswordUserId(null);
    }
  };

  const handleSetPassword = async () => {
    if (!setPasswordUserId) return;
    setSetPasswordSubmitting(true);
    setActionMsg(null);
    try {
      const res = await apiFetch(`/api/super-admin/users/${setPasswordUserId}/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: setPasswordValue }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setActionMsg("Password updated.");
      setSetPasswordUserId(null);
      setSetPasswordValue("");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setSetPasswordSubmitting(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUserId) return;
    if (!editEmail.trim()) {
      setEditError("Email is required.");
      return;
    }
    if (!editProgramId) {
      setEditError("Program is required.");
      return;
    }
    setEditSubmitting(true);
    setEditError(null);
    setActionMsg(null);
    try {
      const res = await apiFetch(`/api/super-admin/users/${editUserId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: editEmail.trim(),
          program_id: editProgramId,
          role: editRole,
        }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setActionMsg("User updated.");
      setEditUserId(null);
      setEditEmail("");
      setEditProgramId("");
      setEditRole("director");
      fetchData();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed");
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleToggleProgramActive = async (program: Program) => {
    setActionMsg(null);
    try {
      const res = await apiFetch(`/api/super-admin/programs/${program.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: program.is_active !== false ? false : true }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setActionMsg(`Program ${program.is_active !== false ? "deactivated" : "activated"}.`);
      fetchData();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Failed");
    }
  };

  const handleCreateProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateProgramSubmitting(true);
    setCreateProgramError(null);
    try {
      const body: { name: string; start_date?: string; end_date?: string } = {
        name: createProgramName.trim(),
      };
      if (createProgramStartDate && createProgramEndDate) {
        body.start_date = createProgramStartDate;
        body.end_date = createProgramEndDate;
      }
      const res = await apiFetch("/api/super-admin/programs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create program");
      setShowCreateProgram(false);
      setCreateProgramName("");
      setCreateProgramStartDate("");
      setCreateProgramEndDate("");
      setActionMsg("Program created.");
      fetchData();
    } catch (e) {
      setCreateProgramError(e instanceof Error ? e.message : "Failed");
    } finally {
      setCreateProgramSubmitting(false);
    }
  };

  const openEditAcademicYear = (p: Program) => {
    const ay = p.default_academic_year;
    if (!ay) return;
    setEditYearProgramId(p.id);
    setEditYearId(ay.id);
    setEditYearStart(ay.start_date);
    setEditYearEnd(ay.end_date);
    setEditYearError(null);
    setEditYearOpen(true);
  };

  const closeEditAcademicYear = () => {
    setEditYearOpen(false);
    setEditYearProgramId("");
    setEditYearId("");
    setEditYearStart("");
    setEditYearEnd("");
    setEditYearError(null);
  };

  const handleSaveEditAcademicYear = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editYearId || !editYearProgramId) return;
    setEditYearSaving(true);
    setEditYearError(null);
    try {
      const res = await apiFetch(
        `/api/admin/academic-years/${editYearId}?programId=${encodeURIComponent(editYearProgramId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date: editYearStart, end_date: editYearEnd }),
          credentials: "include",
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error || "Failed to update");
      setActionMsg("Academic year updated.");
      closeEditAcademicYear();
      fetchData();
    } catch (e) {
      setEditYearError(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setEditYearSaving(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const res = await apiFetch("/api/super-admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: createEmail.trim(),
          password: createPassword,
          program_id: createProgramId,
          role: createRole,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create user");
      setShowCreate(false);
      setCreateEmail("");
      setCreatePassword("");
      setCreateProgramId("");
      setCreateRole("director");
      setActionMsg("User created.");
      fetchData();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed");
    } finally {
      setCreateSubmitting(false);
    }
  };

  if (loading) return <p className="text-gray-600">Loading…</p>;
  if (error)
    return (
      <div className="text-red-600 space-y-2">
        <p>{error}</p>
        {(error === "Unauthorized" || error === "Forbidden") && (
          <p className="text-sm text-gray-600">
            <form action="/logout" method="post" className="inline">
              <button type="submit" className="underline hover:no-underline bg-transparent border-none cursor-pointer p-0 text-sm text-gray-600">Log out and log in again</button>
            </form>
            {". "}
            Super admins: ensure your email is in{" "}
            <code className="bg-gray-100 px-1 rounded">SUPER_ADMIN_EMAILS</code> (Vercel env vars).
          </p>
        )}
      </div>
    );

  return (
    <div className="space-y-6">
      {actionMsg && (
        <div className="p-3 rounded bg-blue-50 border border-blue-200 text-sm text-blue-800">
          {actionMsg}
        </div>
      )}

      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">Programs</h2>
          <button
            type="button"
            onClick={() => setShowCreateProgram((s) => !s)}
            className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors shadow-sm"
          >
            {showCreateProgram ? "Cancel" : "Create program"}
          </button>
        </div>
        {showCreateProgram && (
          <form
            onSubmit={handleCreateProgram}
            className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3 mb-4"
          >
            <h3 className="font-medium">Create program</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={createProgramName}
                onChange={(e) => setCreateProgramName(e.target.value)}
                placeholder="e.g. UCI Nephrology Fellowship"
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <p className="text-xs text-gray-500">Optional: set academic year range (11–13 months). Leave blank to use default Jul 1 – Jun 30.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Academic year start</label>
                <input
                  type="date"
                  value={createProgramStartDate}
                  onChange={(e) => setCreateProgramStartDate(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Academic year end</label>
                <input
                  type="date"
                  value={createProgramEndDate}
                  onChange={(e) => setCreateProgramEndDate(e.target.value)}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            {createProgramError && <p className="text-sm text-red-600">{createProgramError}</p>}
            <button
              type="submit"
              disabled={createProgramSubmitting}
              className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {createProgramSubmitting ? "Creating…" : "Create"}
            </button>
          </form>
        )}
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-3 text-left font-medium">Program</th>
                <th className="p-3 text-left font-medium">Academic year</th>
                <th className="p-3 text-left font-medium">Active</th>
                <th className="p-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {programs.map((p) => (
                <tr key={p.id} className="border-t border-gray-200">
                  <td className="p-3">{p.name}</td>
                  <td className="p-3">
                    {p.default_academic_year
                      ? formatYearRange(p.default_academic_year.start_date, p.default_academic_year.end_date)
                      : "Not set"}
                  </td>
                  <td className="p-3">{p.is_active !== false ? "Yes" : "No"}</td>
                  <td className="p-3 flex flex-wrap gap-2">
                    {p.default_academic_year && (
                      <button
                        type="button"
                        onClick={() => openEditAcademicYear(p)}
                        className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
                      >
                        Edit academic year
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleToggleProgramActive(p)}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
                    >
                      {p.is_active !== false ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editYearOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit academic year</h3>
              <form onSubmit={handleSaveEditAcademicYear} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                  <input
                    type="date"
                    value={editYearStart}
                    onChange={(e) => setEditYearStart(e.target.value)}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
                  <input
                    type="date"
                    value={editYearEnd}
                    onChange={(e) => setEditYearEnd(e.target.value)}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <p className="text-xs text-gray-500">Range must span 11–13 months.</p>
                {editYearError && <p className="text-sm text-red-600">{editYearError}</p>}
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={closeEditAcademicYear}
                    className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={editYearSaving}
                    className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
                  >
                    {editYearSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">Users</h2>
          <button
            type="button"
            onClick={() => setShowCreate((s) => !s)}
            className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors shadow-sm"
          >
            {showCreate ? "Cancel" : "Create user"}
          </button>
        </div>

      {showCreate && (
        <form
          onSubmit={handleCreateUser}
          className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3"
        >
          <h3 className="font-medium">Create user</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Temporary password</label>
              <input
                type="text"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                required
                minLength={6}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
              <select
                value={createProgramId}
                onChange={(e) => setCreateProgramId(e.target.value)}
                required
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select…</option>
                {programs
                  .filter((p) => p.is_active !== false)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value)}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="director">Director</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
                <option value="super_admin">Super Admin</option>
              </select>
            </div>
          </div>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <button
            type="submit"
            disabled={createSubmitting}
            className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-sm"
          >
            {createSubmitting ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-3 text-left font-medium">Email</th>
              <th className="p-3 text-left font-medium">Program</th>
              <th className="p-3 text-left font-medium">Role</th>
              <th className="p-3 text-left font-medium">Active</th>
              <th className="p-3 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-200">
                <td className="p-3">{u.email}</td>
                <td className="p-3">{u.program_name}</td>
                <td className="p-3">{u.role ?? "—"}</td>
                <td className="p-3">{u.is_active ? "Yes" : "No"}</td>
                <td className="p-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditUserId(u.id);
                        setEditEmail(u.email);
                        setEditProgramId(u.program_id ?? "");
                        setEditRole(u.role ?? "director");
                        setEditError(null);
                      }}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
                    >
                      Edit
                    </button>
                    {u.program_id && (
                      <button
                        type="button"
                        onClick={() => handleToggleActive(u)}
                        className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
                      >
                        {u.is_active ? "Deactivate" : "Activate"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleResetPassword(u)}
                      disabled={resettingPasswordUserId === u.id}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {resettingPasswordUserId === u.id ? "Sending…" : "Reset password"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSetPasswordUserId(u.id);
                        setSetPasswordValue("");
                      }}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors shadow-sm"
                    >
                      Set password
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>

      {setPasswordUserId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full">
            <h3 className="font-semibold mb-2">Set temporary password</h3>
            <input
              type="text"
              value={setPasswordValue}
              onChange={(e) => setSetPasswordValue(e.target.value)}
              placeholder="New password (min 6 chars)"
              minLength={6}
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 mb-4 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setSetPasswordUserId(null);
                  setSetPasswordValue("");
                }}
                className="px-5 py-2.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSetPassword}
                disabled={setPasswordSubmitting || setPasswordValue.length < 6}
                className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-sm"
              >
                {setPasswordSubmitting ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editUserId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <form
            onSubmit={handleSaveEdit}
            className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full"
          >
            <h3 className="font-semibold mb-4">Edit user</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  required
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Program</label>
                <select
                  value={editProgramId}
                  onChange={(e) => setEditProgramId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="">Select…</option>
                  {programs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.is_active === false ? " (Inactive)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  <option value="director">Director</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                  <option value="super_admin">Super Admin</option>
                </select>
              </div>
            </div>
            {editError && <p className="text-sm text-red-600 mt-2">{editError}</p>}
            <div className="flex gap-3 mt-4">
              <button
                type="button"
                onClick={() => {
                  setEditUserId(null);
                  setEditEmail("");
                  setEditProgramId("");
                  setEditRole("director");
                  setEditError(null);
                }}
                className="px-5 py-2.5 rounded-lg text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editSubmitting}
                className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-sm"
              >
                {editSubmitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
