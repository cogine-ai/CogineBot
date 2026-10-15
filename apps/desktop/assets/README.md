# Desktop icons

The CogineBot C artwork comes from the approved brand assets. The shared Apple
Icon Composer source is
[`packages/ui-tokens/assets/CogineBot.icon`](../../../packages/ui-tokens/assets/CogineBot.icon).
The original `Rakazo.icon` is retained as upstream source, not used for packaging.

Mac packaging requires Xcode 26 or newer. Electron builder compiles
`CogineBot.icon` into `Assets.car` for Tahoe and generates `icon.icns` for older
macOS versions. `icon-macos.png` is the 256-pixel pre-Tahoe ICNS export, including
Dock margins, used by development launches.

`icon.png` is the approved 1024-pixel Linux export. `icon.ico` is the approved
Windows export with 16, 24, 32, 48, 64, 128, and 256-pixel frames. These are
platform-specific exports of the same C artwork.
