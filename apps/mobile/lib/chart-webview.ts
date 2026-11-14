export const CHART_SCRIPT_PATH = "/api/v1/assets/chart.js";
export const CHART_TIMEOUT_MS = 20_000;

function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function chartDocument(apiBase: string): string {
  const url = new URL(CHART_SCRIPT_PATH, apiBase);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("Invalid chart server");
  const policy = `default-src 'none'; script-src ${url.href}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><style>html,body{margin:0;padding:0;font:14px system-ui;overflow-x:auto}svg{display:block;max-width:100%;height:auto}.title{font-weight:600;margin-bottom:4px}.legend{display:flex;flex-wrap:wrap;gap:8px}.legend span{display:inline-flex;align-items:center;gap:4px}.legend i{width:10px;height:10px;display:inline-block}</style><script src="${attribute(url.href)}" crossorigin="anonymous" referrerpolicy="no-referrer"></script></head><body><div id="chart"></div></body></html>`;
}

export function chartBootScript(request: {
  requestId: string;
  spec: Record<string, unknown>;
  data: unknown[];
  foreground: string;
  background: string;
  height?: number;
}): string {
  return `(function(){try{RakazoChart.draw(${scriptData(request)});}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({requestId:${scriptData(request.requestId)},type:"failed"}));}})();true;`;
}

export function parseChartMessage(
  raw: string,
  requestId: string,
): { type: "failed" } | { type: "drawn"; height: number } | null {
  try {
    const message = JSON.parse(raw);
    if (message.requestId !== requestId) return null;
    if (message.type === "failed") return { type: "failed" };
    if (
      message.type === "drawn" &&
      Number.isFinite(message.height) &&
      message.height >= 80 &&
      message.height <= 10000
    )
      return { type: "drawn", height: message.height };
  } catch {
    /* Untrusted bridge messages never escape into the thread. */
  }
  return null;
}
