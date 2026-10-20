import { ChatMarkdown, RemoteImagesContext } from "@rakazo/chat-ui/web";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const initialMarkdown =
  params.get("markdown") ??
  [
    "```mermaid",
    "flowchart LR",
    "  accTitle: Purchase flow",
    "  A[Choose item] --> B{In stock?}",
    "  B -->|Yes| C[Place order]",
    "  B -->|No| D[Notify me]",
    "```",
  ].join("\n");

function Fixture() {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [streaming, setStreaming] = useState(params.has("stream"));
  const [dark, setDark] = useState(params.has("dark"));
  const [remoteImages, setRemoteImages] = useState(params.has("remote"));

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ markdown: string; streaming?: boolean }>).detail;
      setMarkdown(detail.markdown);
      if (detail.streaming !== undefined) setStreaming(detail.streaming);
    };
    window.addEventListener("diagram-update", update);
    return () => window.removeEventListener("diagram-update", update);
  }, []);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto min-w-0 max-w-3xl space-y-5">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <h1 className="mr-auto font-medium">Diagram preview</h1>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={dark}
              onChange={(event) => setDark(event.target.checked)}
            />
            Dark theme
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={streaming}
              onChange={(event) => setStreaming(event.target.checked)}
            />
            Streaming
          </label>
        </header>
        <div data-testid="diagram-fixture" className="min-w-0">
          <RemoteImagesContext.Provider value={remoteImages}>
            <ChatMarkdown streaming={streaming}>{markdown}</ChatMarkdown>
          </RemoteImagesContext.Provider>
        </div>
        <details className="text-sm text-muted-foreground">
          <summary>Preview input</summary>
          <label className="mt-3 block">
            Markdown source
            <textarea
              className="mt-1 block min-h-48 w-full border border-border bg-background p-2 font-mono text-foreground"
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={remoteImages}
              onChange={(event) => setRemoteImages(event.target.checked)}
            />
            Load remote images
          </label>
        </details>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
