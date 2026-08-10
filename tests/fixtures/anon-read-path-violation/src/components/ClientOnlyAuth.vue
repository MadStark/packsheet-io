<script setup lang="ts">
// Violation #3, and the one that motivated the edge-based formulation of Invariant
// A: rendered with `client:only`, so the Astro compiler drops this component's
// import from the emitted server module entirely. The island therefore appears in
// the unioned build graph as an orphan — it imports auth, but nothing imports it,
// so no walk starting at a page entry can ever reach it. It still ships to every
// visitor of the page that renders it.
import '../lib/auth/index';
</script>

<template>
  <p>client-only auth</p>
</template>
