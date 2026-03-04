#!/usr/bin/env node
/**
 * Test script for Super Admin API auth.
 * Usage: TEST_EMAIL=you@example.com TEST_PASSWORD=secret node scripts/test-super-admin-auth.mjs
 * Requires dev server running: npm run dev
 */
const BASE = "http://localhost:3000";

async function main() {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  if (!email || !password) {
    console.log("Usage: TEST_EMAIL=you@example.com TEST_PASSWORD=secret node scripts/test-super-admin-auth.mjs");
    console.log("Ensure SUPER_ADMIN_EMAILS in .env.local includes your email, and dev server is running.");
    process.exit(1);
  }

  console.log("1. Logging in...");
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok || !loginData.access_token) {
    console.error("Login failed:", loginData.error || loginRes.status);
    process.exit(1);
  }
  const token = loginData.access_token;
  console.log("   OK - got token");

  console.log("2. Fetching /api/super-admin/users with Bearer token...");
  const usersRes = await fetch(`${BASE}/api/super-admin/users`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  const usersData = await usersRes.json();
  if (!usersRes.ok) {
    console.error("Super Admin API failed:", usersData.error || usersRes.status);
    process.exit(1);
  }
  if (!Array.isArray(usersData)) {
    console.error("Unexpected response:", usersData);
    process.exit(1);
  }
  console.log(`   OK - got ${usersData.length} users`);

  console.log("3. Fetching /api/super-admin/programs with Bearer token...");
  const programsRes = await fetch(`${BASE}/api/super-admin/programs`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  const programsData = await programsRes.json();
  if (!programsRes.ok) {
    console.error("Super Admin programs API failed:", programsData.error || programsRes.status);
    process.exit(1);
  }
  if (!Array.isArray(programsData)) {
    console.error("Unexpected response:", programsData);
    process.exit(1);
  }
  console.log(`   OK - got ${programsData.length} programs`);

  console.log("\nSuper Admin auth test PASSED.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
