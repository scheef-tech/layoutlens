type Shot = { locale: string; breakpoint: number; path: string };
type RunManifest = {
  id: string;
  url: string;
  breakpoints: number[];
  locales: string[];
  out_dir: string;
  shots: Shot[];
  _servedBy?: string;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadFromServer(baseUrl: string): Promise<RunManifest> {
  return fetchJson<RunManifest>(`${baseUrl.replace(/\/$/, "")}/manifest`);
}

async function placeImageInto(
  parent: FrameNode,
  bytes: Uint8Array,
  name: string,
  offsetY: number,
  width: number,
  height: number
): Promise<void> {
  const image = figma.createImage(bytes);
  const rect = figma.createRectangle();
  rect.name = name;
  rect.fills = [{ type: "IMAGE", scaleMode: "FIT", imageHash: image.hash }];
  rect.resize(width, height);
  rect.y = offsetY;
  parent.appendChild(rect);
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export default async function () {
  try {
    const stored = (await figma.clientStorage.getAsync("layoutlensBaseUrl")) as
      | string
      | undefined;
    const server =
      stored && stored.length > 0 ? stored : "http://localhost:7777";
    const manifest = await loadFromServer(server);
    // Group by breakpoint rows, locale columns
    const COL_GAP = 48;
    const ROW_GAP = 96;
    let x = 0;
    let y = 0;
    let lastBreakpoint: number | null = null;

    const page = figma.currentPage;

    let rowMaxHeight = 0;
    for (const shot of manifest.shots) {
      if (lastBreakpoint !== null && shot.breakpoint !== lastBreakpoint) {
        y += rowMaxHeight + ROW_GAP;
        x = 0;
        rowMaxHeight = 0;
      }
      lastBreakpoint = shot.breakpoint;

      // Get meta once
      const absPart = decodeURIComponent(shot.path.split("abs=")[1] || "");
      const meta = await fetchJson<{ width: number; height: number }>(
        `${server.replace(/\/$/, "")}/meta?abs=${encodeURIComponent(absPart)}`
      );

      const displayWidth = 800; // target display width per shot
      const scale = displayWidth / Math.max(1, meta.width);

      // Container frame for this shot
      const shotFrame = figma.createFrame();
      shotFrame.name = `${shot.locale} · ${shot.breakpoint}`;
      shotFrame.x = x;
      shotFrame.y = y;
      shotFrame.resize(displayWidth, 10);

      const MAX = 4096;
      let currentY = 0;
      if (meta.height > MAX) {
        let top = 0;
        while (top < meta.height) {
          const sliceH = Math.min(MAX, meta.height - top);
          const bytes = await fetchBytes(
            `${server.replace(/\/$/, "")}${
              shot.path
            }&sliceTop=${top}&sliceHeight=${sliceH}`
          );
          const displayHeight = Math.max(1, Math.round(sliceH * scale));
          await placeImageInto(
            shotFrame,
            bytes,
            `${shot.locale} · ${shot.breakpoint} · y=${top}`,
            currentY,
            displayWidth,
            displayHeight
          );
          currentY += displayHeight + 16; // spacing between slices
          top += sliceH;
        }
      } else {
        const bytes = await fetchBytes(
          `${server.replace(/\/$/, "")}${shot.path}`
        );
        const displayHeight = Math.max(1, Math.round(meta.height * scale));
        await placeImageInto(
          shotFrame,
          bytes,
          `${shot.locale} · ${shot.breakpoint}`,
          currentY,
          displayWidth,
          displayHeight
        );
        currentY += displayHeight;
      }

      // Resize shot container to fit
      shotFrame.resize(displayWidth, currentY);
      page.appendChild(shotFrame);

      x += displayWidth + COL_GAP;
      rowMaxHeight = Math.max(rowMaxHeight, shotFrame.height);
    }
    figma.viewport.scrollAndZoomIntoView(page.children);
    figma.notify("Imported LayoutLens run into Figma");
    figma.closePlugin();
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "string"
        ? e
        : JSON.stringify(e);
    figma.notify(msg, { timeout: 5000 });
    figma.closePlugin(msg);
  }
}
