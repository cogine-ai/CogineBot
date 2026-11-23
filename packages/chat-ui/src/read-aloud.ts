import type {
  ReadAloudSettings,
  UpdateReadAloudInput,
  UpdateReadAloudResult,
} from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

type PreferenceTransport<Settings, Input, Problem extends string> = {
  read: (signal: AbortSignal) => Promise<Settings>;
  write: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<{ status: "updated" | Problem; settings: Settings }>;
  isCurrent: () => boolean;
};

export function usePreferenceSettings<Settings, Input, Problem extends string>(
  transport: PreferenceTransport<Settings, Input, Problem>,
) {
  const binding = useRef<{ controller: AbortController; transport: typeof transport } | null>(null);
  const busy = useRef(false);
  const [accepted, setAccepted] = useState<{
    transport: typeof transport;
    settings: Settings;
  } | null>(null);
  const settings = accepted?.transport === transport ? accepted.settings : null;
  const [pending, setPending] = useState(true);
  const [problem, setProblem] = useState<"load" | "save" | Problem | null>(null);

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

  async function save(input: Input) {
    const request = binding.current;
    if (request?.transport !== transport || busy.current || !transport.isCurrent()) return false;
    busy.current = true;
    setPending(true);
    setProblem(null);
    try {
      const result = await transport.write(input, request.controller.signal);
      if (request !== binding.current || !transport.isCurrent()) return false;
      setAccepted({ transport, settings: result.settings });
      if (result.status === "updated") return true;
      setProblem(result.status);
    } catch {
      if (request === binding.current && transport.isCurrent()) setProblem("save");
    } finally {
      if (request === binding.current) {
        busy.current = false;
        setPending(false);
      }
    }
    return false;
  }

  return { settings, pending, problem, load, save };
}

export function useReadAloudSettings(
  transport: PreferenceTransport<
    ReadAloudSettings,
    UpdateReadAloudInput,
    Exclude<UpdateReadAloudResult["status"], "updated">
  >,
) {
  return usePreferenceSettings(transport);
}
