<script setup lang="ts">
// The leak a review actually demonstrated against the real site, reduced to a fixture.
//
// It touches NEITHER of the two sets the first half of Invariant D is anchored on: it is
// not inside src/lib/auth/, and it is not on FIXTURE_AUTH_CONSUMERS. It does not import
// the choke point either, so Invariant A has nothing to say about it, and it names no
// privileged key, so Invariant C does not either. Every guardrail in this file was green
// while this exact shape shipped the whole GoTrue stack to every anonymous reader — the
// only visible symptom was the client Rollup pass getting several dozen modules bigger.
//
// What makes it a violation is the pair of facts nothing else here can see together: the
// module is in the CLIENT pass (src/pages/supabase-island.astro hydrates it with
// `client:load`), and it imports `@supabase/*`. That is what
// checkSupabaseStaysOffTheClient reports, and this is the only thing in the fixture that
// makes it report anything.
//
// `createBrowserClient` is referenced rather than called. The island is server-rendered
// once before it hydrates, and calling it there would want a `document`; the import is
// what ships, and the import is the whole point.
import { createBrowserClient } from '@supabase/ssr';

const sdkIsHere = typeof createBrowserClient === 'function';
</script>

<template>
  <p>supabase island {{ sdkIsHere }}</p>
</template>
