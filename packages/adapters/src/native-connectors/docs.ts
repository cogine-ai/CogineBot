import type { NativeActionContext } from "./action.js";
import contract from "./docs.contract.json" with { type: "json" };
import type { Obj, WorkspaceImplementation } from "./workspace-google.js";
import {
  currentRevision,
  enc,
  googleCall,
  identity,
  invalid,
  object,
  workspaceActions,
  workspaceFile,
  workspaceTemplate,
  workspaceWrite,
} from "./workspace-google.js";

const READ_SCOPES = ["documents.readonly", "documents", "drive.readonly", "drive"];
const WRITE_SCOPES = ["documents", "drive"];
function operation(input: Obj): Obj {
  if (input.kind === "insert")
    return {
      insertText: {
        location: { index: input.index, tabId: input.tabId },
        text: input.text,
      },
    };
  if (input.kind === "replace")
    return {
      replaceAllText: {
        containsText: { text: input.find, matchCase: input.matchCase },
        replaceText: input.replace,
        tabsCriteria: { tabIds: [input.tabId] },
      },
    };
  if (input.kind === "delete") {
    if (Number(input.startIndex) >= Number(input.endIndex))
      invalid("The UTF-16 range must end after it starts.");
    return {
      deleteContentRange: {
        range: { startIndex: input.startIndex, endIndex: input.endIndex, tabId: input.tabId },
      },
    };
  }
  return invalid("Unsupported document text operation.");
}
function tabIds(document: Obj): Set<string> {
  const ids = new Set<string>();
  const visit = (tabs: unknown) => {
    if (!Array.isArray(tabs)) return;
    for (const value of tabs) {
      const tab = object(value);
      if (tab.tabProperties && typeof tab.tabProperties === "object") {
        const id = object(tab.tabProperties).tabId;
        if (typeof id === "string") ids.add(id);
      }
      visit(tab.childTabs);
    }
  };
  visit(document.tabs);
  return ids;
}
async function edit(kind: string, args: Obj, context: NativeActionContext): Promise<Obj> {
  const ops = kind === "batch" ? (args.operations as Obj[]) : [{ ...args, kind }];
  const requests = ops.map(operation);
  return workspaceWrite(
    `docs.text.${kind}`,
    args,
    context,
    async () => {
      await workspaceFile(context, args.documentId, WRITE_SCOPES);
      const document = await currentRevision(
        context,
        "documents",
        args.documentId,
        args.expectedRevisionId,
      );
      const tabs = tabIds(document);
      if (ops.some((op) => !tabs.has(String(op.tabId))))
        invalid("Choose a tab returned by the current document read.");
      return {
        method: "POST",
        path: `/documents/${enc(args.documentId)}:batchUpdate`,
        body: { requests, writeControl: { requiredRevisionId: args.expectedRevisionId } },
      };
    },
    (value) => {
      const result = identity(value, "documentId", args.documentId);
      if (!Array.isArray(result.replies) || result.replies.length !== requests.length)
        throw new Error("Incomplete document write acknowledgement");
      return {
        documentId: args.documentId,
        result,
        outcome: "succeeded",
        atomicVersionPrecondition: true,
      };
    },
    () => ({ documentId: args.documentId, atomicVersionPrecondition: true }),
  );
}
const implementations: Record<string, WorkspaceImplementation> = {
  "docs.documents.get": async (args, context) => {
    await workspaceFile(context, args.documentId, READ_SCOPES);
    return {
      document: identity(
        await googleCall(context, {
          method: "GET",
          path: `/documents/${enc(args.documentId)}`,
          query: { includeTabsContent: true, suggestionsViewMode: "SUGGESTIONS_INLINE" },
        }),
        "documentId",
        args.documentId,
      ),
    };
  },
  "docs.documents.create": (args, context) =>
    workspaceWrite(
      "docs.documents.create",
      args,
      context,
      async () => ({ method: "POST", path: "/documents", body: { title: args.title } }),
      (value) => ({ document: identity(value, "documentId"), outcome: "succeeded" }),
      (output) => ({ documentId: object(output.document).documentId }),
    ),
  "docs.text.insert": (args, context) => edit("insert", args, context),
  "docs.text.replace": (args, context) => edit("replace", args, context),
  "docs.text.delete": (args, context) => edit("delete", args, context),
  "docs.text.batch": (args, context) => edit("batch", args, context),
  "docs.templates.create": (args, context) => workspaceTemplate("docs", args, context),
};
export const docsActions = workspaceActions(contract, implementations);
export const DOCS_ACTIONS = docsActions;
export const docsContractVersion = contract.frozenAt;
