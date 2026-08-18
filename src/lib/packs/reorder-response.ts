/**
 * The round trip of a reorder (PK-37), from the island's side: what
 * `src/pages/packs/reorder.ts` can answer with, what each of those answers MEANS, and what
 * `src/components/PackContents.vue` is entitled to tell the visitor about it.
 *
 * `reorder-request.ts` is this module's mirror image — that one turns a request into an
 * intent on the server, this one turns a response into an outcome on the client. The two
 * halves of one protocol, each in a file a test can call.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE ISLAND'S OWN SCRIPT BLOCK
 * ---------------------------------------------------------------------------
 *
 * Everything below used to live in `<script setup>` in `src/components/PackContents.vue`,
 * defended by that component's own note that a decision taken inside a drag handler is a
 * decision nothing in this repository can execute. PK-37's independent review was right
 * that the note is legitimate for the POINTER handlers and does not extend one inch past
 * them. `environment: 'node'` denies the suite a `DragEvent`, a `dataTransfer` and a
 * `getBoundingClientRect`; it denies it nothing that these functions touch. Not one of them
 * reads a pointer, a DOM node or a Vue ref: they read a decoded JSON body and a status
 * code, and `sendReorder` needs a stubbed `fetch` and nothing else.
 *
 * The comparison that settles it is `parseReorderIntent` next door: the same KIND of work —
 * read an untrusted payload, refuse what cannot be vouched for, return a value — held in
 * place by the 446 lines of `tests/packs-reorder-request.test.ts`. The only difference was
 * that one lived in a `.ts` and the other in an SFC. `tests/packs-reorder-response.test.ts` now walks the
 * branch table below case by case.
 *
 * What stayed in the component is what genuinely cannot be reached: `slotFor`'s
 * `getBoundingClientRect` arithmetic, the `dragstart`/`dragover`/`drop` plumbing, the grip's
 * `pointerdown`/`pointerup` arming, and the Vue state those handlers write.
 *
 * ---------------------------------------------------------------------------
 * THE BRANCH TABLE, AND WHY EVERY ROW OF IT IS A DIFFERENT SENTENCE
 * ---------------------------------------------------------------------------
 *
 * `fetch` resolving is not the same fact as the move landing, and the version of this code
 * that shipped to review conflated them in three separate places. Each of the seven
 * outcomes below says something different about (a) whether the write happened and (b) what
 * the tree on screen is now worth, and a client that cannot tell them apart has to guess —
 * which in practice means claiming the optimistic answer was confirmed.
 *
 *   applied      A 200 whose body is a plan this tree can apply in full. The only outcome
 *                that has actually established anything, and the only one that says "Saved".
 *   unconfirmed  A 200 whose body this client cannot read. See `planOf`.
 *   stale        A 200 carrying a plan that names rows this tree does not have. See
 *                `unknownPlanRows` in `./drag`.
 *   refused      A non-2xx. The endpoint's own sentence, which it wrote for a visitor.
 *   signedOut    A 303 to sign-in, followed by `fetch`, so `response.ok` describes the
 *                sign-in page.
 *   timedOut     No answer within `REORDER_TIMEOUT_MS`.
 *   offline      `fetch` itself rejected.
 *
 * NOTHING HERE PROMISES THAT A WRITE DID NOT HAPPEN unless it can. `OFFLINE_MESSAGE` and
 * `TIMEOUT_MESSAGE` are deliberately different sentences for that reason and it is the
 * single most easily-got-wrong line in the file: a request that never left the machine
 * really does leave the pack unchanged, and a request that was sent and not answered in
 * time may well have been applied in full. Telling a visitor "the pack is unchanged" about
 * the second is a false statement they may act on by dragging again.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * Same rule and same two reasons as `./routes`, `./reorder` and `./drag`: Invariant A in
 * `tests/anonymous-read-path.test.ts` is an EDGE rule that does not care what a module
 * contains, and this module is bundled into the browser by the island that imports it. It
 * opens no client and reads no cookie — the session travels on the `fetch` as an httpOnly
 * cookie the browser attaches and this code cannot see.
 */

import { PACK_REORDER_PATH } from './routes';
import { unknownPlanRows, type PositionedCategory } from './drag';
import type { PositionUpdate, ReorderPlan, RunUpdate } from './reorder';
import type { ReorderIntent } from './reorder-request';

// ---------------------------------------------------------------------------
// Reading the response body
// ---------------------------------------------------------------------------

/**
 * The endpoint answers `{ ok, message }` on every failure, in one shape, deliberately. Read
 * defensively anyway: this is a `fetch` whose response could be a proxy's error page or a
 * truncated body, and a `payload.message` read off `null` is a TypeError inside a drag.
 */
export function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : null;
}

/**
 * One run's `updates` array, or `null` for anything that is not one.
 *
 * A POSITION IS AN ARRAY INDEX, AND THAT IS THE TEST APPLIED. `denseUpdates` in
 * `src/lib/packs/reorder.ts` produces every position this can ever receive, and it produces
 * them from `forEach`'s own `index` — a safe non-negative integer, always. So the check
 * here is `Number.isSafeInteger(position) && position >= 0`, which is character for
 * character what `readIndex` in `./reorder-request` applies to `toIndex` on the way in, and
 * for the matching reason: the reconstructed type should be the produced type rather than a
 * superset of it. `Number.isFinite` — which this used until PK-37's independent review —
 * admits `0.5`, `-3` and `2 ** 60`, none of which any correct server can send, all of which
 * would be written into a row's `position` and then sorted on.
 *
 * The difference from `readIndex` is what happens next, not what is tested: an out-of-range
 * `toIndex` is a benign race the server clamps, whereas a position that is not an index is
 * a server this client does not understand, and the caller refuses the whole plan rather
 * than repairing it.
 */
export function readUpdates(value: unknown): PositionUpdate[] | null {
  if (!Array.isArray(value)) return null;
  const updates: PositionUpdate[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, position } = entry as { id?: unknown; position?: unknown };
    if (typeof id !== 'string' || typeof position !== 'number') return null;
    if (!Number.isSafeInteger(position) || position < 0) return null;
    updates.push({ id, position });
  }
  return updates;
}

/**
 * The applied plan, or `null` for anything this cannot vouch for.
 *
 * EVERY FIELD IS CHECKED RATHER THAN CAST, and the reason is specific rather than ceremony: a
 * `position` that arrived as `undefined` — from a body shaped differently than expected —
 * would be written into a row and then compared, and `undefined` in a comparator produces
 * `NaN`, which sorts as "equal to everything". The pack would not error; it would render in
 * an order nobody chose. Refusing the whole plan is the only outcome that cannot do that.
 *
 * A `null` FROM HERE IS NOT A FAILED WRITE, and the caller must not report one. It means
 * this client did not recognise a body that arrived with a 2xx: a proxy interstitial, a
 * cached HTML page, a truncated body, or a response shape a deploy changed while this tab
 * stayed open. See `sendReorder`'s `unconfirmed` branch.
 */
export function planOf(payload: unknown): ReorderPlan | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { ok?: unknown; runs?: unknown; reparent?: unknown };
  if (body.ok !== true || !Array.isArray(body.runs)) return null;

  const runs: RunUpdate[] = [];
  for (const run of body.runs) {
    if (typeof run !== 'object' || run === null) return null;
    const { parentId, updates } = run as { parentId?: unknown; updates?: unknown };
    const read = readUpdates(updates);
    if (typeof parentId !== 'string' || read === null) return null;
    runs.push({ parentId, updates: read });
  }

  const raw = body.reparent;
  if (raw === null || raw === undefined) return { runs, reparent: null };
  if (typeof raw !== 'object') return null;
  const { id, parentId } = raw as { id?: unknown; parentId?: unknown };
  if (typeof id !== 'string' || typeof parentId !== 'string') return null;
  return { runs, reparent: { id, parentId } };
}

// ---------------------------------------------------------------------------
// The outcomes
// ---------------------------------------------------------------------------

/**
 * What one reorder round trip established. See the branch table in the module comment.
 *
 * A DISCRIMINATED UNION RATHER THAN A `{ ok, message }` PAIR, because the caller has three
 * separate decisions to take from it — which sentence to show, whether that sentence is an
 * error or a status, and what to do with the tree — and two of the three are NOT functions
 * of the first. `unconfirmed` and `stale` are both errors carrying no plan, and they want
 * opposite things done to the tree.
 */
export type ReorderOutcome =
  | { readonly kind: 'applied'; readonly plan: ReorderPlan }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'signedOut' }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'offline' };

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
//
// Never a raw PostgREST/Postgres string — the endpoint already collapses those into
// sentences (see its REORDER_FAILED_MESSAGE); these cover the cases it never gets to
// answer at all, plus the one case where it answered and this client could not read it.

/** The confirmation for the request itself, and that is ALL it claims. There is no longer a
 *  line telling the visitor to reload to see the real order: the list they are looking at IS
 *  the order, and there is no second copy of it left on the page to disagree with it. */
export const REORDER_SAVED_MESSAGE = 'Order saved.';

/**
 * The fallback for a non-2xx whose body carried no sentence of its own — a 502 from a proxy
 * in front of the Worker, a body that was not JSON, a `{ ok: false }` with the `message`
 * missing.
 *
 * IT IS THE SAME SENTENCE AS THE ENDPOINT'S OWN `REORDER_FAILED_MESSAGE`, deliberately and
 * not by import: `src/pages/packs/reorder.ts` is a route, so nothing may import from it, and
 * inventing a second wording for the identical situation would mean a visitor could see two
 * different sentences depending on whether the endpoint got far enough to write one. If one
 * is ever reworded the other should be too, which is what this paragraph is for.
 */
export const REORDER_SAVE_FAILED_MESSAGE =
  'That move could not be saved. Reload the pack and try again.';

/**
 * A 2xx this client could not read, and the sentence is written to claim exactly that and
 * no more.
 *
 * IT DOES NOT SAY "SAVED", which is what stood here before PK-37's independent review, on
 * the argument that "the write landed". It does not know that. The whole of the evidence is
 * a status code in the 200s from something that answered on this URL; a proxy interstitial
 * and a cached page produce one too. Nor does it say the move was LOST, which would be the
 * opposite lie — the optimistic tree is kept, because this island's prediction came from the
 * same functions the endpoint plans with and is the best available answer, and reverting it
 * would throw away a move that most likely happened.
 *
 * So the sentence names the one thing that is certainly true and gives the visitor the one
 * action that resolves it. Reloading is cheap and settles the question outright.
 */
export const REORDER_UNCONFIRMED_MESSAGE =
  'That move was sent, but the reply could not be read, so it is not confirmed. Reload the pack to see its saved order.';

/**
 * A plan that names rows this tree does not have. See `unknownPlanRows` in `./drag`.
 *
 * THE WRITE LANDED AND THE SENTENCE SAYS SO. This is the ordinary two-tabs case: the
 * endpoint planned from rows it read for itself, and the plan is correct about a pack this
 * tab last saw some time ago. Nothing is wrong with the database; what is stale is the list
 * on screen, and applying a plan half of which matches nothing would leave it staler still
 * while looking like it had been updated.
 */
export const REORDER_STALE_MESSAGE =
  'That move was saved, but this list is out of date with the pack. Reload to see its current order.';

/** A request `fetch` itself rejected — no response, no headers, nothing sent that we know
 *  of. This is the ONE failure that may honestly promise the pack is unchanged. */
export const REORDER_OFFLINE_MESSAGE =
  'That move did not reach the server, so the pack is unchanged. Check your connection and try again.';

/**
 * The deadline expired. A DIFFERENT SENTENCE FROM `REORDER_OFFLINE_MESSAGE`, and the
 * difference is the point rather than a nicety: a request that was sent and not answered
 * within the deadline may have been applied in full, so "the pack is unchanged" would be a
 * statement this code cannot support and the visitor might act on by dragging again.
 */
export const REORDER_TIMEOUT_MESSAGE =
  'The server did not answer in time, so that move is not confirmed. Reload the pack to see its saved order.';

export const REORDER_SIGNED_OUT_MESSAGE =
  'Your session has expired, so that move was not saved. Sign in again.';

/** A notice as the island renders it: the sentence, and whether it reads as a failure. */
export interface ReorderNotice {
  readonly text: string;
  readonly kind: 'error' | 'status';
}

/**
 * The sentence for an outcome, and whether it is an error.
 *
 * `applied` IS THE ONLY `'status'`, which is the whole correction this function encodes:
 * six of the seven outcomes are things going wrong, and five of those six used to be
 * reachable while the surface showed "Saved" or showed nothing at all.
 *
 * The `switch` is exhaustive over `ReorderOutcome['kind']` and returns from every arm, so
 * `noImplicitReturns` (on, via astro/tsconfigs/strict) makes an eighth outcome a compile
 * error here rather than an outcome with no sentence.
 */
export function reorderNotice(outcome: ReorderOutcome): ReorderNotice {
  switch (outcome.kind) {
    case 'applied':
      return { text: REORDER_SAVED_MESSAGE, kind: 'status' };
    case 'unconfirmed':
      return { text: REORDER_UNCONFIRMED_MESSAGE, kind: 'error' };
    case 'stale':
      return { text: REORDER_STALE_MESSAGE, kind: 'error' };
    case 'refused':
      return { text: outcome.message, kind: 'error' };
    case 'signedOut':
      return { text: REORDER_SIGNED_OUT_MESSAGE, kind: 'error' };
    case 'timedOut':
      return { text: REORDER_TIMEOUT_MESSAGE, kind: 'error' };
    case 'offline':
      return { text: REORDER_OFFLINE_MESSAGE, kind: 'error' };
  }
}

/**
 * Whether the optimistic tree must be thrown away and the pre-drag tree put back.
 *
 * THREE ANSWERS COLLAPSED INTO A BOOLEAN, and the third is `kind === 'applied'`, which the
 * caller reads directly because only that arm carries the plan to apply. So: apply the
 * server's plan when there is one, revert when this function says so, and otherwise keep
 * what is on screen.
 *
 * KEEPING IS NOT THE SAME AS SUCCEEDING. `unconfirmed`, `stale` and `timedOut` all keep the
 * optimistic order and all report an error, because in each of them the move probably or
 * certainly landed and reverting would show the visitor an order that is wrong in the other
 * direction. `signedOut`, `refused` and `offline` revert, because in those three the server
 * either said no or was never reached, and the last order it agreed to is the honest thing
 * to render.
 */
export function reorderRevertsTree(outcome: ReorderOutcome): boolean {
  return outcome.kind === 'signedOut' || outcome.kind === 'refused' || outcome.kind === 'offline';
}

// ---------------------------------------------------------------------------
// sendReorder
// ---------------------------------------------------------------------------

/**
 * How long a move may go unanswered before the island stops waiting.
 *
 * A DEADLINE EXISTS AT ALL BECAUSE `fetch` HAS NONE. Nothing in the platform ever settles a
 * request whose connection is open and silent, so before this the island's `catch` could
 * not run, its `finally` could not clear `pending`, and — since `draggable` is gated on
 * `!pending` — every row in the pack quietly stopped being draggable, with no status line,
 * for as long as the socket stayed up. The component's own comment claimed the `catch`
 * covered "a Worker that never answered"; it did not, and could not.
 *
 * TEN SECONDS is chosen against what this endpoint does rather than as a round number: one
 * authenticated read of a pack and one RPC against the same Postgres, which is tens of
 * milliseconds warm and a Worker cold start plus a connection at the very worst. A visitor
 * still looking at a spinner ten seconds after dropping a row has learned everything a
 * longer wait would teach them. It is a parameter with a default rather than a constant
 * read inside the function so `tests/packs-reorder-response.test.ts` can drive the timeout
 * branch in milliseconds instead of holding the suite open.
 */
export const REORDER_TIMEOUT_MS = 10_000;

/**
 * The one `fetch` this island makes, as a parameter rather than a global.
 *
 * INJECTED SO THE ORCHESTRATION IS TESTABLE, which is the only reason. The component passes
 * `window.fetch`; the suite passes a stub. Typed as the platform's own `fetch` so a stub
 * that ignores the `signal` does not typecheck as one — the timeout branch depends on the
 * stub honouring it exactly as the real implementation does.
 */
export type ReorderFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sends one move and says what came back. Total: no response, no body and no thrown
 * `fetch` makes this throw.
 *
 * THE BODY IS A `ReorderIntent` — the exact type `parseReorderIntent` accepts on the other
 * end — rather than the `Record<string, string | number>` it was typed as until PK-37's
 * independent review. The wire field names and the intent's property names are the same
 * names (`REORDER_FIELD` in `./reorder-request` is what makes that true and is what the
 * island spells its object with), so there is nothing to translate and no reason for the
 * weaker type, under which a body missing `toCategoryId` or carrying a `toIndex` as a string
 * satisfied the parameter and failed at the parser.
 *
 * WHAT THAT DOES AND DOES NOT CHECK TODAY, because the honest answer is narrower than it
 * looks and the gap is worth knowing about. This parameter is enforced against any caller
 * `tsc` or `astro check` reads — every `.ts` and `.astro` file, and every test. It is NOT
 * enforced against the ONE caller that exists today: `npm run check` runs `astro check`,
 * `tsc --noEmit`, ESLint and Prettier, and none of the four type-checks the `<script setup>`
 * of a `.vue` file. That was verified rather than assumed — deleting the `toCategoryId`
 * property from the island's request object leaves `npm run check` exiting 0. So in
 * `src/components/PackContents.vue` this type is documentation plus a correct annotation
 * waiting for a checker; the day `vue-tsc` joins that script, it starts failing builds with
 * no further change here. Adding it is not this ticket's, and typing the parameter weakly in
 * the meantime would only guarantee the gap stayed open afterwards.
 *
 * ROWS ARE TAKEN, NOT A TREE THIS FUNCTION OWNS. `rows` is the tree the caller's optimistic
 * plan was computed against — the same one it will apply the returned plan to — and it is
 * used for exactly one thing: `unknownPlanRows`, which decides whether the answer describes
 * a pack this tab still recognises. Nothing here mutates or returns it.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING. `redirected` comes first because a signed-out
 * caller is answered with a 303 to sign-in (the rule for every route under `/packs`) which
 * `fetch` follows, so `response.ok` would describe the sign-in page and `planOf` would
 * refuse its HTML as an unreadable body — reporting "not confirmed" for a session that has
 * simply expired. `ok` comes next so the endpoint's own sentence is preferred over anything
 * this module could invent. Only then is the body read as a plan.
 */
export async function sendReorder(
  send: ReorderFetch,
  body: ReorderIntent,
  rows: readonly PositionedCategory[],
  timeoutMs: number = REORDER_TIMEOUT_MS,
): Promise<ReorderOutcome> {
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const response = await send(PACK_REORDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: deadline,
    });

    if (response.redirected) return { kind: 'signedOut' };

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok)
      return { kind: 'refused', message: messageOf(payload) ?? REORDER_SAVE_FAILED_MESSAGE };

    const plan = planOf(payload);
    if (plan === null) return { kind: 'unconfirmed' };
    if (unknownPlanRows(rows, plan).length > 0) return { kind: 'stale' };
    return { kind: 'applied', plan };
  } catch {
    // TWO FAILURES ARRIVE HERE AND THEY MEAN DIFFERENT THINGS. `deadline.aborted` is the
    // one this module set itself, and it is asked rather than the error being inspected
    // because the rejection an abort produces is not the same object in every runtime (a
    // `DOMException` named `TimeoutError` in the browser and in Node's undici, an
    // `AbortError` in older ones) while the signal's own state is specified. Everything
    // else — DNS, a dropped connection, a refused TLS handshake — is `offline`, which is
    // the only branch entitled to promise the pack is unchanged.
    return deadline.aborted ? { kind: 'timedOut' } : { kind: 'offline' };
  }
}
