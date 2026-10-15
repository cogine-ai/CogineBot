import type { ConfigContext, ExpoConfig } from "expo/config";

const RELEASE_PROFILES = new Set(["production", "android-apk"]);

export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = process.env.EAS_BUILD_PROFILE ?? "";
  const releaseBuild = RELEASE_PROFILES.has(profile);
  const owner = process.env.EXPO_OWNER?.trim();
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  if (releaseBuild || profile === "preview" || owner || projectId) {
    if (!owner || !projectId) {
      throw new Error("EXPO_OWNER and EAS_PROJECT_ID must identify your own Expo project.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new Error("EAS_PROJECT_ID must be a valid Expo project UUID.");
    }
  }

  if (releaseBuild) {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) {
      throw new Error(
        "EXPO_PUBLIC_API_URL must be set in the EAS production environment before building a release.",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
    }
  }

  return {
    ...config,
    ...(owner && projectId
      ? {
          owner,
          extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
          updates: {
            ...config.updates,
            url: `https://u.expo.dev/${projectId}`,
          },
        }
      : {}),
  } as ExpoConfig;
};
