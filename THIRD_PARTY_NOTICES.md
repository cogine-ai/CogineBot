# Third-party notices

This file preserves license notices for identified third-party material retained in the Rakazo baseline at commit `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`. Rakazo's root [LICENSE](LICENSE) and existing source attribution notices are retained separately.

The official license snapshots below were checked on 2026-10-09 and are pinned to the stated source commits. These snapshot commits are license evidence; they have not been established as the revisions originally used for the imports or ports in Rakazo. This notice collection does not claim to be a complete inventory of all dependencies or assets. Dependencies and other third-party material included in a distribution remain subject to their respective licenses.

## Beautiful UI primitives

- Source project: [TurboKach/ai-native-react-components](https://github.com/TurboKach/ai-native-react-components).
- Official license snapshot: [`05dab2d2b5f1f3e40029776e339a486d70491079`](https://raw.githubusercontent.com/TurboKach/ai-native-react-components/05dab2d2b5f1f3e40029776e339a486d70491079/LICENSE).

The retained file headers identify these primitives as hand-ported from beautifului.dev / TurboKach/ai-native-react-components under MIT, with attribution to Turbo. The CSS header describes ported keyframes. The original revision used for that port has not been determined.

Retained baseline paths:

- `apps/web/src/components/ai/primitives.tsx`
- `apps/web/src/components/ai/beautiful-ui.css`

Full license notice from the official snapshot:

```text
MIT License

Copyright (c) 2026 Turbo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## shadcn UI components

- Source project: [shadcn-ui/ui](https://github.com/shadcn-ui/ui).
- Official license snapshot: [`c003e96852fa9534aee40b2cb85a96d8bd38732d`](https://raw.githubusercontent.com/shadcn-ui/ui/c003e96852fa9534aee40b2cb85a96d8bd38732d/LICENSE.md).

The retained Rakazo AGENTS.md identifies the web components as vendored from the official shadcn registry. packages/ui-web/components.json records the base-nova configuration. The paths below identify that component area; they do not assert that every current file is an unchanged upstream component. The original registry revision used for each component has not been determined. Separately installed dependencies, including Base UI, retain their own licenses.

Retained baseline paths:

- `packages/ui-web/src/components/ui/alert-dialog.tsx`
- `packages/ui-web/src/components/ui/badge.tsx`
- `packages/ui-web/src/components/ui/button.tsx`
- `packages/ui-web/src/components/ui/card.tsx`
- `packages/ui-web/src/components/ui/checkbox.tsx`
- `packages/ui-web/src/components/ui/command.tsx`
- `packages/ui-web/src/components/ui/dialog.tsx`
- `packages/ui-web/src/components/ui/dropdown-menu.tsx`
- `packages/ui-web/src/components/ui/field.tsx`
- `packages/ui-web/src/components/ui/input-group.tsx`
- `packages/ui-web/src/components/ui/input.tsx`
- `packages/ui-web/src/components/ui/kbd.tsx`
- `packages/ui-web/src/components/ui/label.tsx`
- `packages/ui-web/src/components/ui/native-select.tsx`
- `packages/ui-web/src/components/ui/popover.tsx`
- `packages/ui-web/src/components/ui/scroll-area.tsx`
- `packages/ui-web/src/components/ui/select.tsx`
- `packages/ui-web/src/components/ui/separator.tsx`
- `packages/ui-web/src/components/ui/skeleton.tsx`
- `packages/ui-web/src/components/ui/spinner.tsx`
- `packages/ui-web/src/components/ui/switch.tsx`
- `packages/ui-web/src/components/ui/tabs.tsx`
- `packages/ui-web/src/components/ui/textarea.tsx`
- `packages/ui-web/src/components/ui/toggle.tsx`
- `packages/ui-web/src/components/ui/tooltip.tsx`

Full license notice from the official snapshot:

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Composio agent skill

- Source project: [ComposioHQ/composio](https://github.com/ComposioHQ/composio).
- Official license snapshot: [`18b6d46f509ab5fb9b26ef1ebb1e25107f8d416a`](https://raw.githubusercontent.com/ComposioHQ/composio/18b6d46f509ab5fb9b26ef1ebb1e25107f8d416a/LICENSE).

The retained skills-lock.json identifies ComposioHQ/composio and skills/composio/SKILL.md as the source of this skill, with a computed content hash. It does not identify the source commit. The original revision used for the skill import has not been determined.

Retained baseline paths:

- `.agents/skills/composio/SKILL.md`
- `.agents/skills/composio/references/errors.md`
- `.agents/skills/composio/references/for-you.md`
- `.agents/skills/composio/references/platform.md`

Full license notice from the official snapshot:

```text
MIT License

Copyright (c) 2025 Sampark Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
