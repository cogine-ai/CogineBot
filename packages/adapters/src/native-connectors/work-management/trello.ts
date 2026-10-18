import { array, collaborationActions, segment, select } from "../collaboration-action.js";
import { authorize, nonempty, project, sameId } from "./helpers.js";
import contract from "./trello.contract.json" with { type: "json" };

const CARD = [
  "id",
  "idBoard",
  "idList",
  "name",
  "desc",
  "closed",
  "due",
  "dueComplete",
  "start",
  "idMembers",
  "idLabels",
  "idChecklists",
  "dateLastActivity",
  "url",
  "shortUrl",
  "pos",
];
export const trelloActions = collaborationActions(
  contract.actions,
  async (args, run) => {
    const id = run.definition.id;
    if (["trello.boards.list", "trello.lists.list", "trello.cards.list"].includes(id)) {
      const board = id === "trello.boards.list",
        lists = id === "trello.lists.list";
      const fields = board
        ? ["id", "name", "desc", "closed", "idOrganization", "url", "dateLastActivity"]
        : lists
          ? ["id", "idBoard", "name", "closed", "pos"]
          : CARD;
      const path = board
        ? "/members/me/boards"
        : `/boards/${segment(args.board_id)}/${lists ? "lists" : "cards"}/${lists ? "all" : String(args.filter ?? "open")}`;
      const items = array(
        (await run.request({ method: "GET", path, query: { fields: fields.join(",") } })).body,
      ).map((row) => project(row, fields));
      return run.finish({
        items,
        hasMore: null,
        allPagesRead: false,
        collectionScope: board
          ? "member_boards"
          : lists
            ? "board_lists"
            : String(args.filter ?? "open"),
      });
    }
    if (id === "trello.cards.get" || id === "trello.checklists.get") {
      const card = id === "trello.cards.get",
        resource = card ? args.card_id : args.checklist_id;
      const row = sameId(
        project(
          (
            await run.request({
              method: "GET",
              path: `/${card ? "cards" : "checklists"}/${segment(resource)}`,
            })
          ).body,
          card ? CARD : ["id", "idBoard", "idCard", "name", "pos", "checkItems"],
        ),
        resource,
      );
      return run.finish(row);
    }
    if (id === "trello.comments.create") {
      const row = project(
        (
          await run.request(
            {
              method: "POST",
              path: `/cards/${segment(args.card_id)}/actions/comments`,
              body: { text: args.text },
            },
            true,
          )
        ).body,
        ["id", "idMemberCreator", "data", "type", "date"],
      );
      return run.finish(row, { resource_id: String(row.id) });
    }
    const create = id === "trello.cards.create";
    const body = create
      ? select(args, ["idList", "name", "desc", "due", "idMembers"])
      : nonempty(args.changes);
    // Trello's create/update card schema uses comma-separated member IDs.
    if (Array.isArray(body.idMembers)) body.idMembers = body.idMembers.join(",");
    const row = project(
      (
        await run.request(
          {
            method: create ? "POST" : "PUT",
            path: create ? "/cards" : `/cards/${segment(args.card_id)}`,
            body,
          },
          true,
        )
      ).body,
      CARD,
    );
    if (!create) sameId(row, args.card_id);
    return run.finish(row, { resource_id: String(row.id) });
  },
  authorize,
);
