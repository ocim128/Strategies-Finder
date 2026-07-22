/**
 * Leaf module holding the current synthetic-pair metadata.
 *
 * Existence: `data-mining-manager` is registered as a lazy feature in
 * `lib/app-bootstrap.ts`, but several always-loaded modules
 * (`settings-manager`, `settings-handlers`) need
 * to *read* the current synthetic-pair metadata. A static import of
 * `data-mining-manager` from those modules pulls the entire Data Mining UI
 * into the startup chunk and defeats the lazy split (Vite warns that the
 * dynamic import in `app-bootstrap.ts` cannot be split).
 *
 * This leaf holds only the metadata read/write surface — no `lightweight-charts`,
 * no DOM, no UI — so always-loaded modules can read the current pair without
 * forcing `data-mining-manager` to load. The manager remains the sole writer:
 * it calls `setSyntheticPairMetadata(...)` when it generates a pair and clears
 * it when the pair goes stale. Heavy regeneration stays behind a dynamic
 * `import("./data-mining-manager")` at the call sites that need it.
 */

export type SyntheticPairMetadata = { baseSymbol: string; quoteSymbol: string };

let currentSyntheticPair: SyntheticPairMetadata | null = null;

export function getSyntheticPairMetadata(): SyntheticPairMetadata | null {
    return currentSyntheticPair;
}

export function setSyntheticPairMetadata(pair: SyntheticPairMetadata | null): void {
    currentSyntheticPair = pair;
}
