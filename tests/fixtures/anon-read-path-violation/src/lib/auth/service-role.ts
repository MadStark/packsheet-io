// The exemption, executed. This module is INSIDE the choke point directory and it names
// SUPABASE_SERVICE_ROLE_KEY, which is the one place in a codebase where that is allowed:
// a service-role client, if one ever exists, lives here and nowhere else.
//
// The exemption only means anything while a module inside the directory actually holds a
// reference. Without this file, deleting the `if (id.startsWith(authDir)) continue;` line
// from checkServiceRoleKey changes no result in this fixture and the suite stays green
// under the mutation.
//
// It also has to be genuinely in the build graph — a module Rollup never loads is never
// transformed, and "not flagged" would then be true for the uninteresting reason. So
// src/lib/auth/index.ts imports it, which puts it in the graph by the same route the rest
// of the choke point gets there.
export const PRIVILEGED_KEY_NAME = 'SUPABASE_SERVICE_ROLE_KEY';
