import type { NativeActionContext } from "./action.js";
import contract from "./slides.contract.json" with { type: "json" };
import type { Obj, WorkspaceImplementation } from "./workspace-google.js";
import {
  currentRevision,
  enc,
  googleCall,
  identity,
  invalid,
  object,
  replacements,
  workspaceActions,
  workspaceFile,
  workspaceTemplate,
  workspaceWrite,
} from "./workspace-google.js";

const READ_SCOPES = ["presentations.readonly", "presentations", "drive.readonly", "drive"];
const WRITE_SCOPES = ["presentations", "drive"];
async function imageUrl(value: unknown, context: NativeActionContext): Promise<void> {
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    invalid("Use a public HTTPS image URL without credentials, signed parameters, or fragments.");
  // Google retrieves and retains the URL. No backend credential or private URL is passed to it.
  await context.validateResourceUrl(url.toString());
}
function slide(deck: Obj, id: unknown): Obj {
  const found = Array.isArray(deck.slides)
    ? deck.slides.find((value) => object(value).objectId === id)
    : undefined;
  if (!found) return invalid("Choose a slide returned by the current presentation read.");
  return object(found);
}
function images(deck: Obj): Set<string> {
  const found = new Set<string>();
  const visit = (elements: unknown) => {
    if (!Array.isArray(elements)) return;
    for (const value of elements) {
      const element = object(value);
      if (element.image && typeof element.objectId === "string") found.add(element.objectId);
      if (element.elementGroup) visit(object(element.elementGroup).children);
    }
  };
  if (Array.isArray(deck.slides))
    for (const value of deck.slides) visit(object(value).pageElements);
  return found;
}
async function edit(kind: string, args: Obj, context: NativeActionContext): Promise<Obj> {
  let requests: Obj[] = [];
  return workspaceWrite(
    `slides.${kind}`,
    args,
    context,
    async () => {
      await workspaceFile(context, args.presentationId, WRITE_SCOPES);
      const current = await currentRevision(
        context,
        "presentations",
        args.presentationId,
        args.expectedRevisionId,
      );
      if (kind === "text.replace") requests = replacements(args.replacements);
      else if (kind === "slides.duplicate") {
        slide(current, args.slideObjectId);
        requests = [
          {
            duplicateObject: {
              objectId: args.slideObjectId,
              objectIds: { [String(args.slideObjectId)]: args.newSlideObjectId },
            },
          },
        ];
      } else if (kind === "images.create") {
        slide(current, args.pageObjectId);
        await imageUrl(args.url, context);
        requests = [
          {
            createImage: {
              objectId: args.objectId,
              url: args.url,
              elementProperties: {
                pageObjectId: args.pageObjectId,
                size: {
                  width: { magnitude: args.widthPt, unit: "PT" },
                  height: { magnitude: args.heightPt, unit: "PT" },
                },
                transform: {
                  scaleX: 1,
                  scaleY: 1,
                  translateX: args.xPt,
                  translateY: args.yPt,
                  unit: "PT",
                },
              },
            },
          },
        ];
      } else if (kind === "images.replace") {
        if (!images(current).has(String(args.imageObjectId)))
          invalid("Choose an image returned by the current presentation read.");
        await imageUrl(args.url, context);
        requests = [
          {
            replaceImage: {
              imageObjectId: args.imageObjectId,
              url: args.url,
              imageReplaceMethod: args.imageReplaceMethod,
            },
          },
        ];
      } else invalid("Unsupported presentation edit.");
      return {
        method: "POST",
        path: `/presentations/${enc(args.presentationId)}:batchUpdate`,
        body: { requests, writeControl: { requiredRevisionId: args.expectedRevisionId } },
      };
    },
    (value) => {
      const result = identity(value, "presentationId", args.presentationId);
      if (!Array.isArray(result.replies) || result.replies.length !== requests.length)
        throw new Error("Incomplete presentation acknowledgement");
      return {
        presentationId: args.presentationId,
        result,
        outcome: "succeeded",
        atomicVersionPrecondition: true,
      };
    },
    () => ({
      presentationId: args.presentationId,
      atomicVersionPrecondition: true,
      ...(args.objectId ? { objectId: args.objectId } : {}),
      ...(args.newSlideObjectId ? { newSlideObjectId: args.newSlideObjectId } : {}),
    }),
  );
}
const implementations: Record<string, WorkspaceImplementation> = {
  "slides.presentations.get": async (args, context) => {
    await workspaceFile(context, args.presentationId, READ_SCOPES);
    return {
      presentation: identity(
        await googleCall(context, {
          method: "GET",
          path: `/presentations/${enc(args.presentationId)}`,
        }),
        "presentationId",
        args.presentationId,
      ),
    };
  },
  "slides.presentations.create": (args, context) =>
    workspaceWrite(
      "slides.presentations.create",
      args,
      context,
      async () => ({ method: "POST", path: "/presentations", body: { title: args.title } }),
      (value) => ({ presentation: identity(value, "presentationId"), outcome: "succeeded" }),
      (output) => ({ presentationId: object(output.presentation).presentationId }),
    ),
  "slides.pages.get": async (args, context) => {
    await workspaceFile(context, args.presentationId, READ_SCOPES);
    return {
      page: identity(
        await googleCall(context, {
          method: "GET",
          path: `/presentations/${enc(args.presentationId)}/pages/${enc(args.pageObjectId)}`,
        }),
        "objectId",
        args.pageObjectId,
      ),
    };
  },
  "slides.text.replace": (args, context) => edit("text.replace", args, context),
  "slides.images.create": (args, context) => edit("images.create", args, context),
  "slides.images.replace": (args, context) => edit("images.replace", args, context),
  "slides.slides.duplicate": (args, context) => edit("slides.duplicate", args, context),
  "slides.templates.create": (args, context) => workspaceTemplate("slides", args, context),
};
export const slidesActions = workspaceActions(contract, implementations);
export const SLIDES_ACTIONS = slidesActions;
export const slidesContractVersion = contract.frozenAt;
