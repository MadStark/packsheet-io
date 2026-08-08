// Stands in for the real src/lib/auth/index.ts, so this fixture's own build graph
// has a real "auth choke point" module for the violating pages below to reach. See
// the comment at the top of tests/anonymous-read-path.test.ts for why this fixture
// exists: it is the proof that the walker can actually detect a violation.
export {};
