import type {
  ReadAloudSettings,
  UpdateReadAloudInput,
  UpdateReadAloudResult,
} from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

type ReadAloudTransport = {
  read: (signal: AbortSignal) => Promise<ReadAloudSettings>;
  write: (input: UpdateReadAloudInput, signal: AbortSignal) => Promise<UpdateReadAloudResult>;
  isCurrent: () => boolean;
};

export function useReadAloudSettings(transport: ReadAloudTransport) {
  const binding = useRef<{ controller: AbortController; transport: ReadAloudTransport } | null>(
    null,
  );
  const busy = useRef(false);
  const [accepted, setAccepted] = useState<{
    transport: ReadAloudTransport;
    settings: ReadAloudSettings;
  } | null>(null);
  const settings = accepted?.transport === transport ? accepted.settings : null;
  const [pending, setPending] = useState(true);
  const [problem, setProblem] = useState<"load" | "save" | "conflict" | null>(null);

  const load = useCallback(async () => {
    const request = binding.current;
    if (request?.transport !== transport || busy.current || !transport.isCurrent()) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    try {
      const next = await transport.read(request.controller.signal);
      if (request === binding.current && transport.isCurrent())
        setAccepted({ transport, settings: next });
    } catch {
      if (request === binding.current && transport.isCurrent()) setProblem("load");
    } finally {
      if (request === binding.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }, [transport]);

  useEffect(() => {
    const request = { controller: new AbortController(), transport };
    binding.current = request;
    busy.current = false;
    void load();
    return () => {
      binding.current = null;
      request.controller.abort();
    };
  }, [load, transport]);

  async function save(input: UpdateReadAloudInput) {
    const request = binding.current;
    if (request?.transport !== transport || busy.current || !transport.isCurrent()) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result = await transport.write(input, request.controller.signal);
      if (request !== binding.current || !transport.isCurrent()) return;
      setAccepted({ transport, settings: result.settings });
      if (result.status === "conflict") setProblem("conflict");
    } catch {
      if (request === binding.current && transport.isCurrent()) setProblem("save");
    } finally {
      if (request === binding.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  return { settings, pending, problem, load, save };
}
