# CogineBot app icon

`CogineBot.svg` is the approved CogineBot app-tile artwork, including its centered
C and light background. `pnpm --filter @rakazo/ui-tokens export:brand` uses it to
refresh the product web PNG and ICO assets and mobile web favicon. It applies no
upstream portrait offset and leaves the existing marketing site unchanged.

`CogineBot.icon` retains the upstream Apple Icon Composer document structure and
uses the approved CogineBot C glyph as its centered foreground. The light glyph
is paired with the system dark background; the artwork is not redrawn.

Use the Icon Composer source for macOS and iOS. Xcode 26 or newer compiles the
asset catalog and the legacy macOS ICNS fallback. The original `Rakazo.icon`
remains available as inherited source and is not the CogineBot packaging input.

Desktop Windows/Linux and mobile Android keep their approved platform-specific
exports because launcher masks and safe areas differ. The browser export command
does not overwrite those assets or the mobile splash/notification exports.
