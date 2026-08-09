// Violation #5: reaches the choke point through a dynamic `import()` rather than a
// static one. This is the shape a lazily-loaded auth SDK takes — the module is still
// bundled and still ships, it is just fetched on demand — and Rollup records it under
// `dynamicallyImportedIds`, a different field from the static `importedIds`. The
// graph collector unions both; a collector that read only the static field would let
// this through, and the fixture is what proves it doesn't.
export async function loadAuth(): Promise<unknown> {
  return import('./auth/index');
}
