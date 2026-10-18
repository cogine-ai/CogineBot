import { airtableActions } from "./airtable.js";
import { clickupActions } from "./clickup.js";
import { dropboxActions } from "./dropbox.js";
import { figmaActions } from "./figma.js";
import { hubspotActions } from "./hubspot.js";

export { BusinessFilesAuthorities } from "./auth.js";
export { BUSINESS_FILES_APPS, businessFilesAppIds, isBusinessFilesApp } from "./metadata.js";
export const businessFilesApps = [
  { slug: "clickup", name: "ClickUp", actions: clickupActions },
  { slug: "airtable", name: "Airtable", actions: airtableActions },
  { slug: "dropbox", name: "Dropbox", actions: dropboxActions },
  { slug: "hubspot", name: "HubSpot", actions: hubspotActions },
  { slug: "figma", name: "Figma", actions: figmaActions },
];
