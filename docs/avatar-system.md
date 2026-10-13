# Companion avatars

The avatar identifies a companion before its name is read. All conversation surfaces use the same Gaze artwork, saved appearance, and activity source. The desktop sidebar remains visible when compact; compact rows show the avatar alone, while expanded rows pair it with the name and latest message.

## Appearance

- Use the eleven Gaze silhouettes in this order: circle, square, triangle, pentagon, hexagon, octagon, diamond, pill, column, egg, arch. Body geometry and eye placement live in `@rakazo/core`, shared by web and native rendering.
- Resolve the initial silhouette and eyes deterministically from the Bot identity. An explicit silhouette overrides only the body choice. Preserve the Bot's existing identity color; do not assign colors by role or current activity.
- Frame the static SVG with `viewBox="10 10 80 80"`. Keep a square, nonshrinking frame at every size. Group avatars compose member avatars using the existing member order and count layout.
- Uploaded images retain the existing centered square crop, 256 px WebP storage, and circular presentation. They remain images during activity.
- Replace the previous global Robot/Organic appearance selector with this single companion system. Appearance editing belongs to each Bot. The existing preference contract is left unchanged; this UI work does not migrate records or change backend behavior.

Typical frames are 38 px in the sidebar, 26 px in conversation headers, 24 px in message history, and 72 px in the Bot profile. Composed group members may be 14–25 px. The same geometry must remain legible across those sizes.

## Editing

Hovering over the profile avatar reveals a centered pencil over the avatar. Clicking it opens a compact, anchored editor with Bot and Upload tabs. The Bot tab contains a five-column silhouette grid, eight companion color choices, and Reset. The profile preview stays static while this editor is open so every selection is visible; other active views keep moving. Selection previews immediately and uses the existing queued save path; no additional draft or confirmation flow is introduced.

Upload supports the existing file chooser, drag/drop, and paste interactions. Unsupported or unreadable images show a short error in the editor. Closing the editor or changing Bot identity invalidates an unfinished image read. There is no AI generation tab or new cropping workflow.

## Activity and attention

| Condition | Avatar | Attention dot |
| --- | --- | --- |
| Idle | Static chosen appearance | None unless attention is pending |
| Existing active Run status | Obvious color-preserving movement | Independent of movement |
| Unread message | Unchanged appearance/activity | Blue |
| Pending approval | Unchanged appearance/activity | Yellow, ahead of blue |
| Message history or mention text | Static chosen appearance | No activity indicator |

Yellow means approval only. There is no online/offline indicator or green dot. Attention remains owned by the existing conversation-attention logic, outside the moving artwork.

The activity renderer adapts the already validated official SVG animation core. Working, thinking, and gathering are visual phases of the same existing active status, not new Bot states. All appearances of one active Bot share one frame source, including instances mounted later. Different Bots use stable numeric identity seeds to avoid moving in lockstep.

At sizes below 24 px, retain the Gaze silhouette and apply the shared whole-body motion; do not render tiny particles or three-dot morphs. Larger active avatars can use the full selected choreography. Clip motion within the avatar frame so it never overlaps neighboring avatars or the fixed attention dot.

Only visible active web avatars subscribe to motion. Idle/history/uploaded avatars do not create an animation engine. Reduced-motion, hidden documents, and removal of the final subscriber destroy the source rather than leaving an inactive RAF loop. The motion runtime is loaded only when needed. Mobile shares the appearance contract and uses its existing native motion capabilities; it does not execute a browser SVG runtime.

## Implementation boundaries

Persist appearances through the existing `bots.color` values: a hex color, `hex::shape_n`, or an accepted image data URL. Expand the shared silhouette count to eleven without adding database columns or a new endpoint. Rendering and editing remain frontend work; Run scheduling, group selection, mentions, prompts, skills, approvals, and AI behavior are unchanged.

Keep reference captures and acceptance evidence outside the product checkout. Document runtime source provenance next to the adapter without bundling the full website. Do not add a network dependency for avatars.

## Acceptance

Check light/dark desktop layouts at 1280 and 800 px; expanded/compact sidebar; single and group headers; multiple simultaneous active Bots; tiny group members; long names and multiline messages. Verify appearance changes in all live surfaces and after refresh, image upload/reset, save failure/retry, and switching Bot while an image is loading. Verify synchronized late mounts and source teardown on unmount, hidden documents, and reduced motion. Historical avatars must stay static throughout. Use deterministic component/fixture tests for activity without sending new AI messages.
