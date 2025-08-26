<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";

  let url = $state("");
  let breakpointsInput = $state("320,375,414,768,1024,1280,1440");
  let localesInput = $state("en,de,fr");
  let cookie = $state({
    name: "locale",
    domain: "",
    path: "/",
    sameSite: "Lax" as "Lax" | "Strict" | "None",
    secure: false,
    httpOnly: false,
  });
  let behavior = $state({
    sendAcceptLanguage: false,
    useUrlTemplate: false,
    urlTemplate: "",
  });
  let running = $state(false);

  function parseNumbers(input: string): number[] {
    return input
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  function parseStrings(input: string): string[] {
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function runCapture() {
    running = true;
    const breakpoints = parseNumbers(breakpointsInput);
    const locales = parseStrings(localesInput);
    await invoke("run_screenshot_job", {
      url,
      breakpoints,
      locales,
      cookie,
      behavior,
    });
    running = false;
  }
</script>

<div class="p-6 max-w-3xl mx-auto space-y-6">
  <h1 class="text-2xl font-semibold">LayoutLens</h1>
  <div class="space-y-3">
    <label>URL</label>
    <input
      class="border rounded p-2 w-full"
      bind:value={url}
      placeholder="http://localhost:5173"
    />
  </div>
  <div class="grid grid-cols-2 gap-4">
    <div class="space-y-3">
      <label>Breakpoints (comma)</label>
      <input class="border rounded p-2 w-full" bind:value={breakpointsInput} />
    </div>
    <div class="space-y-3">
      <label>Locales (comma)</label>
      <input class="border rounded p-2 w-full" bind:value={localesInput} />
    </div>
  </div>
  <fieldset class="border rounded p-4 space-y-3">
    <legend class="px-2">Cookie</legend>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <label>Name</label>
        <input class="border rounded p-2 w-full" bind:value={cookie.name} />
      </div>
      <div>
        <label>Domain (optional)</label>
        <input class="border rounded p-2 w-full" bind:value={cookie.domain} />
      </div>
      <div>
        <label>Path</label>
        <input class="border rounded p-2 w-full" bind:value={cookie.path} />
      </div>
      <div>
        <label>SameSite</label>
        <select class="border rounded p-2 w-full" bind:value={cookie.sameSite}>
          <option value="Lax">Lax</option>
          <option value="Strict">Strict</option>
          <option value="None">None</option>
        </select>
      </div>
      <div class="flex items-center gap-2">
        <input type="checkbox" bind:checked={cookie.secure} />
        <span>Secure</span>
      </div>
      <div class="flex items-center gap-2">
        <input type="checkbox" bind:checked={cookie.httpOnly} />
        <span>HttpOnly</span>
      </div>
    </div>
  </fieldset>

  <fieldset class="border rounded p-4 space-y-3">
    <legend class="px-2">Behavior</legend>
    <div class="flex items-center gap-2">
      <input type="checkbox" bind:checked={behavior.sendAcceptLanguage} />
      <span>Send Accept-Language header</span>
    </div>
    <div class="flex items-center gap-2">
      <input type="checkbox" bind:checked={behavior.useUrlTemplate} />
      <span>Use URL template</span>
    </div>
    <input
      class="border rounded p-2 w-full"
      bind:value={behavior.urlTemplate}
      placeholder="/{locale}{pathname} or ?lang={locale}"
    />
  </fieldset>

  <button
    class="px-4 py-2 bg-black text-white rounded"
    on:click={runCapture}
    disabled={running}
  >
    {running ? "Running…" : "Capture"}
  </button>
</div>
