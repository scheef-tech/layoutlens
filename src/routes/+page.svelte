<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let url = $state("http://localhost:5174/");
  let breakpointsInput = $state("320,768,1024,1280,1920,2400");
  // let breakpointsInput = $state("320,375,414,768,1024,1280,1440");
  let localesInput = $state("en,de,es");
  // let localesInput = $state("en,de,es");
  let cookie = $state({
    name: "PARAGLIDE_LOCALE",
    domain: "",
    path: "/",
    // Default to Lax which works without requiring Secure in Chromium
    sameSite: "Lax" as "Lax" | "Strict" | "None",
    secure: false,
    httpOnly: false,
  });
  let behavior = $state({
    sendAcceptLanguage: false,
    useUrlTemplate: false,
    urlTemplate: "",
  });
  // Performance / concurrency
  let maxConcurrentPagesInput = $state("6");
  let persistentCache = $state(true);
  let profileDirInput = $state(".playwright-profile");
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
    if (!url) {
      console.warn("URL is required");
      return;
    }
    running = true;
    const breakpoints = parseNumbers(breakpointsInput);
    const locales = parseStrings(localesInput);
    try {
      console.log("Starting capture", { url, breakpoints, locales });
      await invoke("run_screenshot_job", {
        url,
        breakpoints,
        locales,
        cookie,
        behavior,
        // snake_case keys to match Rust parameter names
        profile_dir: persistentCache ? profileDirInput : null,
        max_concurrent_pages: Number(maxConcurrentPagesInput) || undefined,
      });
      console.log("Capture finished");
    } catch (e) {
      console.error("Capture failed", e);
      // optional: show a minimal UI hint
      alert("Capture failed. See console for details.");
    } finally {
      running = false;
    }
  }
</script>

<div class="p-6 max-w-3xl mx-auto space-y-6">
  <h1 class="text-2xl font-semibold">LayoutLens</h1>
  <div class="space-y-3">
    <Label>URL</Label>
    <Input bind:value={url} placeholder="http://localhost:5173" />
  </div>
  <div class="grid grid-cols-2 gap-4">
    <div class="space-y-3">
      <Label>Breakpoints (comma)</Label>
      <Input bind:value={breakpointsInput} />
    </div>
    <div class="space-y-3">
      <Label>Locales (comma)</Label>
      <Input bind:value={localesInput} />
    </div>
  </div>
  <fieldset class="border rounded p-4 space-y-3">
    <legend class="px-2">Cookie</legend>
    <div class="grid grid-cols-2 gap-4">
      <div>
        <Label>Name</Label>
        <Input bind:value={cookie.name} />
      </div>
      <div>
        <Label>Domain (optional)</Label>
        <Input bind:value={cookie.domain} />
      </div>
      <div>
        <Label>Path</Label>
        <Input bind:value={cookie.path} />
      </div>
      <div>
        <Label>SameSite</Label>
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
    <Input
      bind:value={behavior.urlTemplate}
      placeholder="/&#123;locale&#125;&#123;pathname&#125; or ?lang=&#123;locale&#125;"
    />
  </fieldset>

  <fieldset class="border rounded p-4 space-y-3">
    <legend class="px-2">Performance</legend>
    <div class="grid grid-cols-2 gap-4">
      <div class="space-y-2">
        <Label>Max concurrent pages</Label>
        <Input bind:value={maxConcurrentPagesInput} />
      </div>
      <div class="space-y-2">
        <Label>Use persistent cache</Label>
        <div class="flex items-center gap-2">
          <input type="checkbox" bind:checked={persistentCache} />
          <span>Reuse cache between runs</span>
        </div>
      </div>
      <div class="space-y-2 col-span-2">
        <Label>Profile directory</Label>
        <Input bind:value={profileDirInput} />
      </div>
    </div>
  </fieldset>

  <Button onclick={() => runCapture()} disabled={running}>
    {running ? "Running…" : "Capture"}
  </Button>
</div>
