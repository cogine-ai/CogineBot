# App icon source

The CogineBot app icon sources and export scope are documented in
[`CogineBot-brand.md`](CogineBot-brand.md).

- `CogineBot.svg` is the approved centered app-tile source for browser assets.
- `CogineBot.icon` is the shared Apple Icon Composer source for macOS and iOS.
  Xcode 26 or newer compiles it into a Tahoe asset catalog and a legacy macOS ICNS
  fallback.
- `Rakazo.icon` is retained as the original upstream editable source. It is not
  used by CogineBot packaging or the brand export command.

Run `pnpm --filter @rakazo/ui-tokens export:brand` to refresh product web
favicons, web install icons, and the mobile web favicon.
The command retains the existing file names and formats. It does not overwrite
native desktop or mobile icons: Apple Icon Composer and Android launcher exports
remain separate because their masks, appearance, and safe areas differ.

Android adaptive foreground/background and monochrome assets are separate layers;
never bake Mac corners, a rim, or an outer shadow into them. Notification icons
remain white alpha silhouettes. The mobile splash keeps its transparent padding.

The existing `apps/www` marketing site is outside this product brand export.
