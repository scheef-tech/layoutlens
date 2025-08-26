<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  import panzoom from "panzoom";
  import type { RunManifest, Shot } from "$lib/types";

  let manifest = $state<RunManifest | null>(null);
  let shotList = $state<Shot[]>([]);
  let selectedLocale: string | "All" = $state("All");
  let selectedBreakpoint: number | "All" = $state("All");
  let zoom = $state(0.5);
  let canvasEl: HTMLDivElement;
  let wrapperEl: HTMLDivElement;
  let pz: ReturnType<typeof panzoom> | null = null;

  onMount(() => {
    const unlistenPromise = listen<RunManifest>("shots:loaded", (e) => {
      manifest = e.payload;
      shotList = e.payload.shots;
    });

    // Initialize Panzoom on first mount
    if (!pz && canvasEl) {
      pz = panzoom(canvasEl, {
        maxZoom: 3,
        minZoom: 0.1,
        zoomDoubleClickSpeed: 1,
        smoothScroll: false,
        // Only zoom with wheel when Cmd/Meta (or Ctrl) is held – Figma-style
        beforeWheel: (ev: WheelEvent) => {
          const wantZoom = ev.metaKey || ev.ctrlKey;
          // return true to ignore the wheel (so we can pan instead)
          return !wantZoom;
        },
      });
      pz.setTransform(0, 0, zoom);
      pz.on("transform", () => {
        if (!pz) return;
        const t = pz.getTransform();
        zoom = t.scale;
      });
    }
    return () => {
      unlistenPromise.then((un) => un());
      if (pz) {
        pz.dispose();
        pz = null;
      }
    };
  });

  const filtered = $derived(
    shotList.filter(
      (s) =>
        (selectedLocale === "All" || s.locale === selectedLocale) &&
        (selectedBreakpoint === "All" || s.breakpoint === selectedBreakpoint)
    )
  );

  // Figma-style wheel behavior: pan by default; zoom when Cmd/Ctrl held
  function onWheel(e: WheelEvent) {
    if (!pz) return;
    const wantZoom = e.metaKey || e.ctrlKey;
    if (!wantZoom) {
      e.preventDefault();
      // Natural trackpad scrolling pans the canvas
      pz.moveBy(-e.deltaX, -e.deltaY, false);
    }
    // when wantZoom, Panzoom will handle it via beforeWheel=false
  }
</script>

<div
  bind:this={wrapperEl}
  class="h-screen w-screen overflow-hidden select-none"
  onwheel={(e) => onWheel(e)}
>
  <div class="p-3 flex gap-3 items-center border-b">
    <label for="locale">Locale</label>
    <select id="locale" class="border rounded p-1" bind:value={selectedLocale}>
      <option>All</option>
      {#if manifest}
        {#each manifest.locales as loc}
          <option value={loc}>{loc}</option>
        {/each}
      {/if}
    </select>
    <label for="bp">Breakpoint</label>
    <select id="bp" class="border rounded p-1" bind:value={selectedBreakpoint}>
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
      bind:this={canvasEl}
      class="absolute left-1/2 top-1/2"
      style="transform-origin: 0 0;"
    >
      <div class="flex flex-nowrap gap-8">
        {#each filtered as s}
          <figure class="shadow border bg-white">
            <img
              src={convertFileSrc(s.path)}
              alt={`${s.locale} ${s.breakpoint}`}
              draggable="false"
            />
            <figcaption class="text-xs p-2">
              {s.locale} · {s.breakpoint}px
            </figcaption>
          </figure>
        {/each}
      </div>
    </div>
  </div>
</div>
