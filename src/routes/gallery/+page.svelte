<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import type { RunManifest, Shot } from "$lib/types";

  let manifest = $state<RunManifest | null>(null);
  let shotList = $state<Shot[]>([]);
  let selectedLocale: string | "All" = $state("All");
  let selectedBreakpoint: number | "All" = $state("All");
  let zoom = $state(0.5);
  let offsetX = $state(0);
  let offsetY = $state(0);

  listen<RunManifest>("shots:loaded", (e) => {
    manifest = e.payload;
    shotList = e.payload.shots;
  });

  const filtered = $derived(
    shotList.filter(
      (s) =>
        (selectedLocale === "All" || s.locale === selectedLocale) &&
        (selectedBreakpoint === "All" || s.breakpoint === selectedBreakpoint)
    )
  );

  function onWheel(e: WheelEvent) {
    zoom = Math.max(0.1, Math.min(3, zoom + (e.deltaY > 0 ? -0.05 : 0.05)));
  }
</script>

<div class="h-screen w-screen overflow-hidden" on:wheel|passive={onWheel}>
  <div class="p-3 flex gap-3 items-center border-b">
    <label>Locale</label>
    <select class="border rounded p-1" bind:value={selectedLocale}>
      <option>All</option>
      {#if manifest}
        {#each manifest.locales as loc}
          <option value={loc}>{loc}</option>
        {/each}
      {/if}
    </select>
    <label>Breakpoint</label>
    <select class="border rounded p-1" bind:value={selectedBreakpoint}>
      <option>All</option>
      {#if manifest}
        {#each manifest.breakpoints as bp}
          <option value={bp}>{bp}</option>
        {/each}
      {/if}
    </select>
    <div class="ml-auto">Zoom: {Math.round(zoom * 100)}%</div>
  </div>
  <div class="relative h-[calc(100vh-44px)] w-full bg-neutral-50">
    <div
      class="absolute left-1/2 top-1/2"
      style={`transform: translate(-50%, -50%) scale(${zoom}) translate(${offsetX}px, ${offsetY}px);`}
    >
      <div class="flex flex-wrap gap-8">
        {#each filtered as s}
          <figure class="shadow border bg-white">
            <img src={s.path} alt={`${s.locale} ${s.breakpoint}`} />
            <figcaption class="text-xs p-2">
              {s.locale} · {s.breakpoint}px
            </figcaption>
          </figure>
        {/each}
      </div>
    </div>
  </div>
</div>
