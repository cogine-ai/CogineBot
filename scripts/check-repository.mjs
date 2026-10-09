import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const documents = [
  "README.md",
  "README.zh-CN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "UPSTREAM.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/development.md",
  "docs/automation.md",
  "docs/preparation-baseline.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];
const failures = [];
let links = 0;

function headings(file) {
  const content = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  const ids = new Set();
  const occurrences = new Map();
  for (const match of content.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = occurrences.get(slug) ?? 0;
    occurrences.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  return ids;
}

for (const document of documents) {
  const file = path.join(root, document);
  if (!existsSync(file)) {
    failures.push(`Missing document: ${document}`);
    continue;
  }
  const content = readFileSync(file, "utf8");
  const targets = [...content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  targets.push(...[...content.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]));
  for (const raw of targets) {
    const target = raw.replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) continue;
    links += 1;
    const [relative, fragment] = target.split("#");
    const destination = relative
      ? path.resolve(path.dirname(file), decodeURIComponent(relative))
      : file;
    if (path.relative(root, destination).startsWith("..")) {
      failures.push(`${document}: link escapes the repository ${target}`);
      continue;
    }
    if (!existsSync(destination)) {
      failures.push(`${document}: missing link target ${target}`);
      continue;
    }
    if (fragment && destination.endsWith(".md")) {
      const anchor = decodeURIComponent(fragment);
      if (!headings(destination).has(anchor))
        failures.push(`${document}: missing heading ${target}`);
    }
  }
}

const active = readdirSync(path.join(root, ".github/workflows"))
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
if (active.length !== 1 || active[0] !== "repository-ci.yml") {
  failures.push(`Unexpected active workflows: ${active.join(", ")}`);
}
for (const file of ["config.yml", "bug.yml", "self-host.yml", "feature-request.yml"]) {
  const content = readFileSync(path.join(root, ".github/ISSUE_TEMPLATE", file), "utf8");
  if (/rakazo\.com|elie222\/rakazo|mailto:/i.test(content)) {
    failures.push(`Issue entry still routes to upstream contact: ${file}`);
  }
}
for (const file of ["README.md", "README.zh-CN.md", "SECURITY.md"]) {
  if (!existsSync(path.join(root, file))) continue;
  const content = readFileSync(path.join(root, file), "utf8");
  if (/\/Users\/|[A-Za-z]:\\Users\\|BEGIN [A-Z ]*PRIVATE KEY/.test(content)) {
    failures.push(`Private content marker in ${file}`);
  }
}
if (!readFileSync(path.join(root, "LICENSE"), "utf8").includes("Apache License")) {
  failures.push("Root Apache license is missing");
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Repository check passed: ${documents.length} documents, ${links} local links, one active CI workflow.`,
  );
}
