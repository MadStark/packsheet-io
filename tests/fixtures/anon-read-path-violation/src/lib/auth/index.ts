// Stands in for the real src/lib/auth/index.ts, so this fixture's own build graph
// has a real "auth choke point" module for the violating pages below to reach. See
// the comment at the top of tests/anonymous-read-path.test.ts for why this fixture
// exists: it is the proof that the walker can actually detect a violation.
//
// The import below is a deliberate INTRA-directory edge. The choke point's own files
// have to be free to import each other, and this is the only edge in the fixture that
// executes that exemption — without it, deleting the exemption from the checker
// changes nothing that any test can see.
import { SESSION_COOKIE } from './session';

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}
