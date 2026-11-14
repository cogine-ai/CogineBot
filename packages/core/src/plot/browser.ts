import type { PlotSpec } from "./plot-spec.js";
import { buildInteractivePlotParts } from "./plot-spec.js";

type ChartRequest = {
  requestId: string;
  spec: PlotSpec;
  data: unknown[];
  foreground: string;
  background: string;
  height?: number;
};

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/** Fixed first-party WebView entry. Message content is only JSON, never source code. */
export function draw(request: ChartRequest): void {
  const root = document.getElementById("chart");
  if (!root || root.dataset.started) return;
  root.dataset.started = "true";
  const post = (message: Record<string, unknown>) =>
    window.ReactNativeWebView?.postMessage(
      JSON.stringify({ ...message, requestId: request.requestId }),
    );
  // Mobile inspection stays inside the chart. Never navigate the isolated document.
  root.addEventListener("click", (event) => event.preventDefault());
  let width = 0;
  let failed = false;
  const render = () => {
    if (failed) return;
    const nextWidth = Math.max(160, Math.floor(document.documentElement.clientWidth));
    if (nextWidth === width) return;
    width = nextWidth;
    try {
      document.body.style.color = request.foreground;
      document.body.style.backgroundColor = request.background;
      const parts = buildInteractivePlotParts(request.spec, request.data, document, {
        width,
        height: request.height,
      });
      root.replaceChildren();
      if (parts.title) {
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = parts.title;
        root.append(title);
      }
      const legend = document.createElement("div");
      legend.className = "legend";
      for (const swatch of parts.swatches) {
        const item = document.createElement("span");
        const color = document.createElement("i");
        color.style.backgroundColor = swatch.color;
        item.append(color, document.createTextNode(swatch.label));
        legend.append(item);
      }
      root.append(legend, parts.plotted);
      post({ type: "drawn", height: Math.min(10000, Math.max(80, root.scrollHeight)) });
    } catch {
      failed = true;
      root.replaceChildren();
      post({ type: "failed" });
    }
  };
  render();
  window.addEventListener("resize", render);
  window.addEventListener("pagehide", () => window.removeEventListener("resize", render), {
    once: true,
  });
}
