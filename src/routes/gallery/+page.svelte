<script lang="ts">
  import { listen } from "@tauri-apps/api/event";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { open, save } from "@tauri-apps/plugin-dialog";
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
  const MIN_Z = 0.1;
  const MAX_Z = 3;

  onMount(() => {
    const unlistenPromise = listen<RunManifest>("shots:loaded", (e) => {
      manifest = e.payload;
      shotList = e.payload.shots;
    });

    // Initialize Panzoom on first mount
    if (!pz && canvasEl) {
      pz = panzoom(canvasEl, {
        maxZoom: MAX_Z,
        minZoom: MIN_Z,
        zoomDoubleClickSpeed: 1,
        smoothScroll: false,
        // Disable internal wheel handling; we implement Figma-style below
        beforeWheel: () => true,
      });
      pz.moveTo(0, 0);
      pz.zoomAbs(0, 0, zoom);
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
    } else {
      e.preventDefault();
      const current = pz.getTransform().scale;
      const zoomFactor =
        1 + Math.min(Math.max(Math.abs(e.deltaY) / 500, 0.05), 0.5);
      const next = e.deltaY < 0 ? current * zoomFactor : current / zoomFactor;
      const clamped = Math.max(MIN_Z, Math.min(MAX_Z, next));
      // Zoom centered at the cursor position (relative to wrapper)
      const rect = wrapperEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      pz.smoothZoomAbs(x, y, clamped);
    }
  }

  async function exportZip() {
    if (!manifest) return;
    const dest = await save({
      title: "Export gallery as ZIP",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      defaultPath: `layoutlens-${manifest.id}.zip`,
    });
    if (!dest) return;
    await invoke("export_gallery", {
      args: {
        run_dir: manifest.out_dir,
        dest_zip: dest,
      },
    });
    alert("Exported gallery");
  }

  async function importZip() {
    const src = await open({
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      title: "Import gallery ZIP",
    });
    if (!src || Array.isArray(src)) return;
    const outDir = await invoke<string>("import_gallery", {
      args: { src_zip: src },
    });
    // Load its manifest
    const manifestPath = `${outDir}/manifest.json`;
    const res = await fetch(convertFileSrc(manifestPath));
    const data = (await res.json()) as RunManifest;
    manifest = data;
    shotList = data.shots;
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
    <button class="ml-auto border rounded px-2 py-1" onclick={() => importZip()}
      >Import</button
    >
    <button
      class="border rounded px-2 py-1"
      onclick={() => exportZip()}
      disabled={!manifest}>Export</button
    >
    <div>Zoom: {Math.round(zoom * 100)}%</div>
  </div>
  <div class="relative h-[calc(100vh-44px)] w-full bg-neutral-50">
    <div
      bind:this={canvasEl}
      class="absolute left-0 top-0"
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
