// A SECOND module inside the choke point directory. The fixture used to hold exactly
// one file here, and that single-file shape made two mutations of the checker
// undetectable: narrowing `isAuthModule` to recognise only `index.ts`, and deleting the
// `if (isAuthModule(importer)) continue;` line that lets the choke point's own files
// import each other. With one file in the directory neither mutation changes any
// result, so the suite stayed green under both.
//
// src/pages/second-auth-module.astro imports this module directly, which makes the
// first mutation fail; index.ts imports it, which makes the second one fail by
// reporting an intra-directory edge that must never be reported.
export const SESSION_COOKIE = 'fixture-session';
