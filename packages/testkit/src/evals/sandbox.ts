import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];
  readonly filesRead: string[] = [];

  constructor(private readonly seedFiles: Readonly<Record<string, string>> = {}) {
    super();
  }

  override async provision(
    request: Parameters<FakeSandboxProvider["provision"]>[0],
    context: AdapterContext,
  ) {
    const computer = await super.provision(request, context);
    if (computer.fresh) {
      for (const [path, content] of Object.entries(this.seedFiles)) {
        await this.writeFile(
          computer,
          { path, content: new TextEncoder().encode(content) },
          context,
        );
      }
    }
    return computer;
  }

  override async readFile(...args: Parameters<FakeSandboxProvider["readFile"]>) {
    const content = await super.readFile(...args);
    if (Object.keys(this.seedFiles).length) this.filesRead.push(args[1]);
    return content;
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const issue = "Shell execution is unavailable in this offline eval sandbox.";
      if (!this.harnessIssues.includes(issue)) this.harnessIssues.push(issue);
      yield { type: "stderr", data: issue };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}
