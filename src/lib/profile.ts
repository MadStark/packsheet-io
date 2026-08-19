/**
 * The user's profile and settings record (PK-67) — the read and write halves of
 * `public.profiles`, which today holds exactly one setting: which system the account
 * thinks weights in.
 *
 * WHY THIS IS A MODULE AND NOT TWO LINES IN PAGE FRONTMATTER. `vitest.config.ts:64`
 * excludes `src/pages/`, so a branch written in an `.astro` file is a branch no test in
 * this repository can reach — the same reason `src/lib/gear/mutations.ts` exists, and the
 * reason PK-4's review found surviving mutants in code that "obviously worked". The
 * branch that matters here is the one below: a user with no row is not an error, and every
 * caller has to agree about that. Written inline, four pages would each decide it
 * separately, and the day one of them used `.single()` instead of `.maybeSingle()` the
 * account page would 500 for exactly the users who had never opened it.
 *
 * THE VOCABULARY LIVES IN `units.ts`, NOT HERE. `WeightSystem`, `isWeightSystem` and
 * `DEFAULT_WEIGHT_SYSTEM` are all imported rather than redefined, so this module knows how
 * to STORE a preference and nothing about what one means. That split is what keeps
 * `units.ts`'s claim to be the one place a unit decision can hide true after PK-67 gave
 * the product a second place units are mentioned.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import type { PacksheetClient } from './supabase';
import { DEFAULT_WEIGHT_SYSTEM, isWeightSystem, type WeightSystem } from './units';

/**
 * The one column of the settings record the product reads today, named once so the four
 * call sites and the upsert below cannot disagree about its spelling. `profiles` is
 * expected to grow nickname, home country, gender and tagline — see the table comment in
 * `20260817000000_user_profiles.sql` — and each of those arrives as a sibling here rather
 * than as a second module.
 */
const WEIGHT_UNITS_COLUMN = 'weight_units';

/**
 * The hidden `intent` value the Preferences form posts, telling `/account`'s single POST
 * handler this submission apart from the delete-account form already on that page. Same
 * mechanism and the same reason as `DELETE_ACCOUNT_INTENT` in `account-deletion.ts` — two
 * forms, one page, one handler, and neither may act on the other's submission.
 */
export const WEIGHT_SYSTEM_INTENT = 'save-weight-units';

/** The radio group's `name`, matching the column so the form and the upsert cannot drift. */
export const WEIGHT_SYSTEM_FIELD = 'weight_units';

/** Shown after a successful save. A complete sentence, per the house rule
 *  `src/lib/gear/form.ts` states as "NEVER A RAW POSTGRES OR POSTGREST STRING". */
export const WEIGHT_SYSTEM_SAVED_MESSAGE = 'Your weight units have been saved.';

/** Shown when the upsert fails. Deliberately says nothing about what went wrong: the
 *  underlying `PostgrestError` is never rendered, exactly as the delete-account handler on
 *  the same page refuses to render its own. */
export const WEIGHT_SYSTEM_ERROR_MESSAGE =
  'Something went wrong saving your preference. Please try again.';

/**
 * Narrows a Preferences submission to a `WeightSystem`, or `null` for anything else.
 *
 * IN `src/lib/` RATHER THAN IN THE PAGE'S FRONTMATTER, for the reason
 * `src/lib/account-deletion.ts` gives for the identical move on the delete-account gate:
 * `vitest.config.ts:64` excludes `src/pages/`, so a check written there is the one piece of
 * request handling on the page with no test at all.
 *
 * `null` IS A REACHABLE ANSWER, NOT A PARANOID ONE. A radio group with nothing checked
 * posts nothing — the same submission `parseGearItemForm` accounts for on `status`, and
 * genuinely producible by a JavaScript-disabled browser meeting a form rendered before one
 * of the two options existed, or by a tampered request. The caller re-renders with the
 * stored value still selected rather than guessing which the visitor meant, because there
 * is no safe default here: guessing writes a preference the user did not choose.
 */
export function parseWeightSystemForm(form: FormData): WeightSystem | null {
  const raw = form.get(WEIGHT_SYSTEM_FIELD);
  return isWeightSystem(raw) ? raw : null;
}

/**
 * The account's weight system, with a missing row read as the default.
 *
 * ABSENCE IS THE ORDINARY CASE, NOT AN ERROR, and this is the whole reason the function
 * exists. The profiles migration deliberately creates no row on sign-up — no trigger on
 * `auth.users`, no backfill — because reading absence as `'metric'` and saving as an
 * upsert makes "no row" and "a row saying metric" indistinguishable to every caller, and
 * a trigger would only write down the default that the absence already states. So every
 * account that has never opened `/account` has no row here, which is most of them.
 *
 * `maybeSingle()`, NEVER `single()`. `single()` treats zero rows as a `PGRST116` error,
 * which would turn the ordinary state of a fresh account into a failure that every caller
 * then has to special-case — reintroducing, at four call sites, the branch this function
 * exists to own.
 *
 * A REAL QUERY FAILURE ALSO RETURNS THE DEFAULT, and that is a considered choice rather
 * than a swallowed error. The alternative — throwing, or returning a result type every
 * caller must unwrap — would let a transient Postgres hiccup take down the gear closet
 * over a display preference. This value decides which unit a weight is RENDERED in; it
 * cannot make a number wrong, only unfamiliar, because the stored figure is grams either
 * way. Falling back to metric shows a correct weight in a possibly-unwanted unit, which is
 * strictly better than showing nothing. The error is returned alongside so a caller that
 * wants to react to it can, and none has to.
 *
 * Contrast `src/lib/gear/query.ts`, which surfaces its errors: a closet list that silently
 * returned zero rows on failure would tell the visitor their gear was gone. Nothing here
 * can lie about data in that way.
 */
export async function readWeightSystem(
  client: PacksheetClient,
  userId: string,
): Promise<{ readonly system: WeightSystem; readonly error: PostgrestError | null }> {
  const { data, error } = await client
    .from('profiles')
    .select(WEIGHT_UNITS_COLUMN)
    .eq('user_id', userId)
    .maybeSingle();

  // `isWeightSystem` rather than a cast, for the reason it exists: the generated row type
  // widens this column to `string`, and the CHECK constraint that backs it is not proven
  // to still hold by the time a row is read back through a client that says so. Same gap
  // `formatGearStatus` guards on `gear_items.status`.
  const stored = data?.[WEIGHT_UNITS_COLUMN];
  return {
    system: isWeightSystem(stored) ? stored : DEFAULT_WEIGHT_SYSTEM,
    error,
  };
}

/**
 * Saves the account's weight system, creating the profile row if this is the first
 * setting the user has ever changed.
 *
 * UPSERT, NOT UPDATE, and the `onConflict` target is the primary key. Because no row is
 * created at sign-up, the very first save of every account is an INSERT and every save
 * after it is an UPDATE — a bare `.update()` would silently affect zero rows for exactly
 * the users saving for the first time, report success, and re-render the page showing the
 * old value. That is the failure this shape forecloses.
 *
 * `user_id` IS SENT EXPLICITLY even though the column defaults to `auth.uid()`. An upsert
 * has to name the conflict target's value to know which row it is upserting, so unlike a
 * plain insert there is nothing for the default to fill in. It is not a widening:
 * `profiles_insert_own` and `profiles_update_own` both check `user_id = (select
 * auth.uid())`, so a client that sends someone else's id is refused by the policy rather
 * than quietly corrected — the same reasoning `gear_items.user_id`'s own default carries.
 *
 * `created_at`/`updated_at` are not sent and could not usefully be: `profiles_set_row_
 * timestamps` and `profiles_set_updated_at` stamp both server-side on the insert and
 * update paths respectively, precisely so neither is ever client-supplied.
 */
export async function saveWeightSystem(
  client: PacksheetClient,
  userId: string,
  system: WeightSystem,
): Promise<{ readonly error: PostgrestError | null }> {
  const { error } = await client
    .from('profiles')
    .upsert({ user_id: userId, [WEIGHT_UNITS_COLUMN]: system }, { onConflict: 'user_id' });

  return { error };
}
