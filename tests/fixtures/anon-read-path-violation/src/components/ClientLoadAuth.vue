<script setup lang="ts">
// Violation #4: a hydrated island. Unlike the `client:only` sibling, `client:load`
// leaves the component import in the emitted server module, so this one IS reachable
// from its page — it is here so the fixture covers both island directives and the
// difference between them is executed rather than asserted in prose.
import '../lib/auth/index';
</script>

<template>
  <p>client-load auth</p>
</template>
