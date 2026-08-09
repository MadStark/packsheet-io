// A prefix trap, and the only thing in this fixture that executes the trailing
// separator in `join(root, 'src', 'lib', 'auth') + sep`. Drop that `sep` and the
// directory test degrades into a plain string prefix — at which point this file's path
// starts with `src/lib/auth` and it is treated as being INSIDE the choke point, exempt
// from Invariant A. A module called `auth-helpers.ts`, `authz.ts` or `auth.config.ts`
// could then import the SDK freely and CI would stay green.
//
// It is not inside the choke point. It is next to it, and importing the choke point
// from here is a violation like any other.
import { sessionCookieName } from './auth/index';

export function helperCookieName(): string {
  return sessionCookieName();
}
