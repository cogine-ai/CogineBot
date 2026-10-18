/** Per-app Google configuration, not a shared account/grant or a request for all scopes. */
const PREFIX = "https://www.googleapis.com/auth/";
const identity = ["openid", "email"];
const scopes = (...values: string[]) => [...identity, ...values.map((value) => PREFIX + value)];

export const GOOGLE_NATIVE_APPS = {
  "google-calendar": {
    baseUrl: "https://www.googleapis.com/calendar/v3",
    scopes: scopes(
      "calendar.calendarlist.readonly",
      "calendar.events.readonly",
      "calendar.events",
      "calendar.freebusy",
      "calendar.events.freebusy",
    ),
  },
  gmail: {
    baseUrl: "https://gmail.googleapis.com/gmail/v1",
    scopes: scopes("gmail.readonly", "gmail.send", "gmail.compose", "gmail.modify", "gmail.labels"),
  },
  "google-drive": {
    baseUrl: "https://www.googleapis.com/drive/v3",
    scopes: scopes("drive.file", "drive.metadata.readonly", "drive.readonly", "drive"),
  },
  "google-docs": {
    baseUrl: "https://docs.googleapis.com/v1",
    scopes: scopes("documents.readonly", "documents", "drive.file", "drive.readonly", "drive"),
  },
  "google-sheets": {
    baseUrl: "https://sheets.googleapis.com/v4",
    scopes: scopes(
      "spreadsheets.readonly",
      "spreadsheets",
      "drive.file",
      "drive.readonly",
      "drive",
    ),
  },
  "google-slides": {
    baseUrl: "https://slides.googleapis.com/v1",
    scopes: scopes(
      "presentations.readonly",
      "presentations",
      "drive.file",
      "drive.readonly",
      "drive",
    ),
  },
  "google-tasks": {
    baseUrl: "https://tasks.googleapis.com/tasks/v1",
    scopes: scopes("tasks.readonly", "tasks"),
  },
} as const;
export type GoogleNativeApp = keyof typeof GOOGLE_NATIVE_APPS;
export function isGoogleNativeApp(app: string): app is GoogleNativeApp {
  return Object.hasOwn(GOOGLE_NATIVE_APPS, app);
}

export function googleServiceBase(
  app: GoogleNativeApp,
  service?: "drive" | "drive-upload",
): string {
  if (!service) return GOOGLE_NATIVE_APPS[app].baseUrl;
  if (service === "drive-upload" && app === "google-drive")
    return "https://www.googleapis.com/upload/drive/v3";
  if (
    service === "drive" &&
    ["google-drive", "google-docs", "google-sheets", "google-slides"].includes(app)
  )
    return "https://www.googleapis.com/drive/v3";
  throw new Error("This application does not use the requested Google API.");
}
