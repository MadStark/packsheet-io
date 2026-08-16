<script setup lang="ts">
// The case that gives Invariant D its teeth: a module that is ON the allowlist and has no
// business being there. It imports the choke point, so Invariant A would report it — and
// does not, because FIXTURE_AUTH_CONSUMERS names it, which is precisely the mistake being
// modelled. Somebody wrote a plausible-looking line on an allowlist for a module they
// believed was server-only.
//
// It is not server-only. It is a Vue island, hydrated with `client:load` by
// src/pages/allowlisted-island.astro, so the client Rollup pass transforms it and it ships
// to the browser of every visitor of that page along with everything it imports. Without
// this fixture case the new invariant is a function nothing ever calls in anger: the choke
// point's own modules land in the client pass here anyway (the two islands next door drag
// them in), so a checker that only ever reported those would look correct while the
// allowlist half of it — the half the allowlist's soundness rests on — was never executed.
//
// Deliberately built from a real build rather than a synthetic graph. A hand-made
// BuildGraph with an id dropped into `clientIds` proves the function filters a Set; it
// proves nothing about whether Astro really does put an allowlisted island in that Set,
// which is the only claim worth making.
import '../lib/auth/index';
</script>

<template>
  <p>allowlisted island</p>
</template>
