import { z } from "zod";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { Id } from "./ids.js";

// An opaque reference handle: matched exactly by secret_request/forget_secret,
// displayed in list_secrets. Never interpolated into shells, env, or URLs, so
// hyphens are safe.
export const BotSecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

// A name read back from storage. It is deliberately looser than BotSecretName so a row saved
// before the pattern tightened stays listable and removable instead of failing a whole list call.
export const StoredBotSecretName = z.string().min(1).max(256);

export const GENERATED_SECRET_SYMBOLS = "!@#$%^&*-_=+?";
const MIN_GENERATED_SECRET_RANDOM_BITS = 64;

const generatedSecretRulesShape = z.strictObject({
  length: z.number().int().min(8).max(128).default(20),
  lowercase: z.boolean().default(true),
  uppercase: z.boolean().default(true),
  digits: z.boolean().default(true),
  symbols: z.boolean().default(true),
  allowedSymbols: z
    .string()
    .regex(/^[!-/:-@[-`{-~]{1,32}$/, "Use only punctuation characters")
    .optional(),
});
export type GeneratedSecretRules = z.infer<typeof generatedSecretRulesShape>;

/** The disjoint alphabets used by both the strength check and the generator. */
export function generatedSecretAlphabets(rules: GeneratedSecretRules): string[] {
  return [
    rules.lowercase && "abcdefghijklmnopqrstuvwxyz",
    rules.uppercase && "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    rules.digits && "0123456789",
    rules.symbols && [...new Set(rules.allowedSymbols ?? GENERATED_SECRET_SYMBOLS)].join(""),
  ].filter((alphabet): alphabet is string => Boolean(alphabet));
}

export const GeneratedSecretRules = generatedSecretRulesShape.superRefine((rules, ctx) => {
  const alphabets = generatedSecretAlphabets(rules);
  if (!alphabets.length) {
    ctx.addIssue({ code: "custom", message: "Allow at least one kind of character" });
    return;
  }
  const allCharacters = alphabets.reduce((size, alphabet) => size + alphabet.length, 0);
  // The generator takes one independent draw from each required alphabet and fills the
  // remaining positions from their union. An independent shuffle cannot lower this bound.
  const randomBits = alphabets.reduce(
    (bits, alphabet) => bits + Math.log2(alphabet.length),
    (rules.length - alphabets.length) * Math.log2(allCharacters),
  );
  if (randomBits < MIN_GENERATED_SECRET_RANDOM_BITS)
    ctx.addIssue({
      code: "custom",
      path: ["length"],
      message: `Choose a longer length or more characters for at least ${MIN_GENERATED_SECRET_RANDOM_BITS} bits of randomness`,
    });
});

const GenerationPurpose = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe("Explain to the user why you need the new credential. Do not include secret values.");

export const GenerateCommandSecretInput = z
  .strictObject({
    name: BotSecretName,
    type: z.literal("command"),
    purpose: GenerationPurpose,
    rules: GeneratedSecretRules.optional(),
  })
  .superRefine(({ name }, ctx) => {
    const message = commandVariableNameIssue(name);
    if (message) ctx.addIssue({ code: "custom", path: ["name"], message });
  });
export type GenerateCommandSecretInput = z.infer<typeof GenerateCommandSecretInput>;

const SecretHeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/)
  .refine(
    (name) =>
      !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$/i.test(
        name,
      ),
    "Unsupported credential header",
  );

export const BotSecretAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("header"), name: SecretHeaderName }),
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:\r\n]+$/),
  }),
  // A website sign-in. The username and password are both protected; the backend only types
  // them into pages on the saved origin and never sends them as HTTP credentials.
  z.object({ type: z.literal("login") }),
  // A value exported to this bot's shell commands as an environment variable. It has no site.
  z.object({ type: z.literal("command") }),
]);

// Names that change how shells and common runtimes start, where they load code from, or how
// they reach the network. A bot's command variable must never override them. The list is not
// exhaustive: it covers the well-known variables, and the prefix rules below catch whole
// families. Treat an unlisted name as allowed, not as proof it is harmless.
const RESERVED_COMMAND_VARIABLE_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TERM",
  "IFS",
  "ENV",
  "BASH_ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "PS4",
  "TMPDIR",
  "DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // TLS trust: these redirect which certificates common clients accept, or disable the check.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  // OpenSSL config, engine, and module paths can load attacker-controlled code.
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  // Commands and programs git and ssh run on their own behalf.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  // A glibc path that can load extra locale or conversion modules.
  "GCONV_PATH",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
]);
// Whole families a single variable name cannot enumerate: dynamic-loader injection, Rakazo's own
// namespace, git's config file set, and npm's configuration overrides.
const RESERVED_COMMAND_VARIABLE_PREFIXES = [
  "LD_",
  "DYLD_",
  "RAKAZO_",
  "GIT_CONFIG_",
  "NPM_CONFIG_",
];

/** The environment variable a command credential is exported as: `netbird-setup-key` → `NETBIRD_SETUP_KEY`. */
export function commandVariableName(credentialName: string): string {
  return credentialName.toUpperCase().replace(/-/g, "_");
}

/** Why a variable name cannot be exported, or undefined when it can. */
export function commandVariableProblem(variable: string): "invalid" | "reserved" | undefined {
  if (!AGENT_SECRET_NAME_PATTERN.test(variable)) return "invalid";
  if (
    RESERVED_COMMAND_VARIABLE_NAMES.has(variable) ||
    RESERVED_COMMAND_VARIABLE_PREFIXES.some((prefix) => variable.startsWith(prefix))
  ) {
    return "reserved";
  }
  return undefined;
}

function commandVariableNameIssue(credentialName: string): string | undefined {
  const variable = commandVariableName(credentialName);
  const problem = commandVariableProblem(variable);
  if (problem === "reserved") {
    return `$${variable} is reserved and cannot be used as a command variable; choose another name`;
  }
  if (problem === "invalid") return `$${variable} is not a valid environment variable name`;
  return undefined;
}

/** Hosts inside a deployment's own network (loopback, RFC1918, CGNAT, .local). */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.endsWith(".local")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}

/** Provider metadata endpoints that must never become credential targets,
 * even though they sit inside otherwise-private ranges (CGNAT / link-local). */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "169.254.169.254" ||
    host === "169.254.170.2" ||
    host === "100.100.100.200" ||
    host === "metadata.google.internal" ||
    host === "metadata.goog"
  );
}

function botSecretOriginSchema(allowPrivateHttpOrigin: boolean) {
  return z
    .string()
    .max(2048)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
            return false;
          }
          if (isCloudMetadataHost(url.hostname)) return false;
          if (url.protocol === "https:") return true;
          return (
            allowPrivateHttpOrigin && url.protocol === "http:" && isPrivateNetworkHost(url.hostname)
          );
        } catch {
          return false;
        }
      },
      allowPrivateHttpOrigin
        ? "Expected an HTTPS origin, or an HTTP origin on a private LAN host, without a path, credentials, query, or fragment"
        : "Expected an HTTPS origin without a path, credentials, query, or fragment",
    );
}

export function botSecretDestinationSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  const originSchema = botSecretOriginSchema(options?.allowPrivateHttpOrigin === true);
  return z
    .object({
      name: BotSecretName,
      // Empty for a command variable, which has no site. Every other type needs an origin.
      origin: z.string().max(2048).default(""),
      auth: BotSecretAuth,
    })
    .superRefine((destination, ctx) => {
      if (destination.auth.type === "command") {
        if (destination.origin !== "") {
          ctx.addIssue({
            code: "custom",
            path: ["origin"],
            message: "Command variables have no site; leave origin empty",
          });
        }
        const nameIssue = commandVariableNameIssue(destination.name);
        if (nameIssue) ctx.addIssue({ code: "custom", path: ["name"], message: nameIssue });
        return;
      }
      const origin = originSchema.safeParse(destination.origin);
      if (!origin.success) {
        for (const issue of origin.error.issues) {
          ctx.addIssue({ code: "custom", path: ["origin"], message: issue.message });
        }
        return;
      }
      // Private-LAN plain HTTP is for API credentials only. A website login is typed into a page.
      if (destination.auth.type !== "login") return;
      try {
        if (new URL(destination.origin).protocol === "https:") return;
      } catch {
        /* The origin schema already rejects unparseable values. */
      }
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Website logins require an HTTPS origin",
      });
    });
}
export const BotSecretDestination = botSecretDestinationSchema();
export type BotSecretDestination = z.infer<typeof BotSecretDestination>;

export const BOT_SECRET_VALUE_MAX_LENGTH = 16_384;

// Keep writing the pair from older forms until those forms can edit named fields.
export const LoginSecretValue = z.object({
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(4096),
});
export type LoginSecretValue = z.infer<typeof LoginSecretValue>;

/** The optional command credential holds the same password as the website login. */
export function loginCommandName(name: string): string {
  return `${name}-password`;
}

const GenerateLoginSecretInput = z
  .strictObject({
    name: BotSecretName,
    type: z.literal("login"),
    purpose: GenerationPurpose,
    origin: botSecretOriginSchema(false).transform((value) => new URL(value).origin),
    username: LoginSecretValue.shape.username.trim().min(1),
    command: z.boolean().optional(),
    rules: GeneratedSecretRules.optional(),
  })
  .superRefine(({ name, command }, ctx) => {
    if (!command) return;
    const alias = loginCommandName(name);
    const message = BotSecretName.safeParse(alias).success
      ? commandVariableNameIssue(alias)
      : "Use a name of at most 55 characters to also save a command variable";
    if (message) ctx.addIssue({ code: "custom", path: ["name"], message });
  });

export const GenerateSecretInput = z.discriminatedUnion("type", [
  GenerateCommandSecretInput,
  GenerateLoginSecretInput,
]);
export type GenerateSecretInput = z.infer<typeof GenerateSecretInput>;

export const PROTECTED_LOGIN_USERNAME = "[protected username]";

export const LOGIN_FIELD_LIMIT = 8;
export const LoginFieldLabel = z.string().trim().min(1).max(64);
export const DEFAULT_LOGIN_FIELD_LABELS = ["Username", "Password"] as const;
export const WEBSITE_LOGIN_CARD_HEADER = "x-coginebot-website-login-card";
export const LoginFieldLabels = z
  .array(LoginFieldLabel)
  .min(1)
  .max(LOGIN_FIELD_LIMIT)
  .refine(
    (labels) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length,
    "Give each field a different label",
  );
const NamedLoginField = z
  .object({
    label: LoginFieldLabel,
    value: z.string().max(4096),
    hidden: z.boolean(),
  })
  .transform((field) => (field.hidden ? field : { ...field, value: field.value.trim() }))
  .refine((field) => field.value.length > 0, "Enter a value");
type NamedLoginField = z.infer<typeof NamedLoginField>;

export const NamedLoginSecretValue = z
  .strictObject({ fields: z.array(NamedLoginField).min(1).max(LOGIN_FIELD_LIMIT) })
  .refine(
    ({ fields }) => new Set(fields.map(({ label }) => label.toLowerCase())).size === fields.length,
    "Give each field a different label",
  )
  .refine(
    (login) => JSON.stringify(login).length <= BOT_SECRET_VALUE_MAX_LENGTH,
    "This login is too long",
  );
export type NamedLoginSecretValue = z.infer<typeof NamedLoginSecretValue>;

export const WebsiteLoginAnswer = z.strictObject({
  fields: z.array(NamedLoginField).min(1).max(LOGIN_FIELD_LIMIT),
  remember: z.boolean().default(true),
});
export type WebsiteLoginAnswer = z.output<typeof WebsiteLoginAnswer>;

/** Validate the labels against the pending card, keeping older pair cards readable. */
export function loginCardAnswer(
  labels: readonly string[] | undefined,
  input: { answer: string; username?: string; login?: WebsiteLoginAnswer },
) {
  if (labels) {
    if (input.answer || input.username !== undefined) return;
    const parsed = WebsiteLoginAnswer.safeParse(input.login);
    if (!parsed.success) return;
    const { fields, remember } = parsed.data;
    if (
      fields.length !== labels.length ||
      fields.some(({ label }, index) => label !== labels[index])
    )
      return;
    const value = NamedLoginSecretValue.safeParse({ fields });
    if (value.success) return { plaintext: encodeLoginSecret(value.data), remember };
    return;
  }
  if (input.login !== undefined) return;
  const pair = LoginSecretValue.safeParse({
    username: input.username?.trim(),
    password: input.answer,
  });
  if (pair.success) return { plaintext: encodeLoginSecret(pair.data), remember: true };
}

const VISIBLE_LOGIN_LABELS = new Set([
  "username",
  "user name",
  "email",
  "email address",
  "e-mail",
  "phone",
  "phone number",
  "mobile number",
  "account number",
  "member id",
  "id",
  "id number",
]);

export function loginCardFields(labels: readonly string[]): WebsiteLoginAnswer["fields"] {
  return labels.map((label) => ({
    label,
    value: "",
    hidden: !VISIBLE_LOGIN_LABELS.has(label.toLowerCase()),
  }));
}

type StoredLoginSecretValue = LoginSecretValue | NamedLoginSecretValue;

export function encodeLoginSecret(value: StoredLoginSecretValue): string {
  return JSON.stringify(
    "fields" in value ? NamedLoginSecretValue.parse(value) : LoginSecretValue.parse(value),
  );
}

export function parseLoginSecretWrite(plaintext: string): StoredLoginSecretValue {
  const value: unknown = JSON.parse(plaintext);
  // A write that supplies named fields may not fall back to the legacy pair.
  return value !== null && typeof value === "object" && Object.hasOwn(value, "fields")
    ? NamedLoginSecretValue.parse(value)
    : LoginSecretValue.parse(value);
}

export function decodeLoginSecret(plaintext: string): StoredLoginSecretValue {
  const value: unknown = JSON.parse(plaintext);
  // Older servers validated the pair but encrypted the original JSON, including extra keys.
  const legacy = LoginSecretValue.safeParse(value);
  return legacy.success ? legacy.data : NamedLoginSecretValue.parse(value);
}

export function loginSecretFields(value: StoredLoginSecretValue): readonly NamedLoginField[] {
  return "fields" in value
    ? value.fields
    : [
        { label: "Username", value: value.username, hidden: false },
        { label: "Password", value: value.password, hidden: true },
      ];
}

/** Written atomically with the protected value, distinct from action approval. */
export function botSecretSubmissionSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  return z.object({ credentialSaved: botSecretDestinationSchema(options) });
}
export const BotSecretSubmission = botSecretSubmissionSchema();
export const RunLoginSubmission = z.object({
  loginProvided: BotSecretDestination,
  remember: z.literal(false),
});

/**
 * Owner-facing destination input. Structural only: the origin rules depend on the server's
 * private-HTTP opt-in, so the server enforces them when it stores the value.
 */
export const BotSecretDestinationInput = z
  .object({
    name: BotSecretName,
    // Omitted or empty for a command variable, which has no site.
    origin: z.string().max(2048).default(""),
    auth: BotSecretAuth,
  })
  .superRefine((destination, ctx) => {
    if (destination.auth.type !== "command" && destination.origin.length === 0) {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "A site is required" });
    }
  });

const BotSecretRevision = z.string().min(1).max(128);

export const BotSecretPutInput = z.object({
  botId: Id,
  destination: BotSecretDestinationInput,
  value: z.string().min(1).max(BOT_SECRET_VALUE_MAX_LENGTH),
  // A null revision explicitly creates a new credential. Older clients omit the precondition.
  expectedRevision: BotSecretRevision.nullable().optional(),
});
export type BotSecretPutInput = z.infer<typeof BotSecretPutInput>;

export const BotSecretRemoveInput = z.object({
  botId: Id,
  name: StoredBotSecretName,
  expectedRevision: BotSecretRevision.optional(),
});
export type BotSecretRemoveInput = z.infer<typeof BotSecretRemoveInput>;

// Older servers accept the old routes but ignore their unknown revision field.
export const BotSecretPutForEditInput = BotSecretPutInput.extend({
  expectedRevision: BotSecretRevision.nullable(),
});
export const BotSecretRemoveForEditInput = BotSecretRemoveInput.extend({
  expectedRevision: BotSecretRevision,
});

/**
 * What the owner can see about a saved credential. It never carries the protected value.
 * `name` is read loosely and `auth` is nullable so one stored row that no longer passes the
 * current schema cannot fail the whole list call and lock the owner out of removing it.
 * A null `auth` means the stored settings can't be read.
 */
export const BotSecretMetadata = z.object({
  name: StoredBotSecretName,
  origin: z.string(),
  auth: BotSecretAuth.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: BotSecretRevision.optional(),
  namedLogin: z.literal(true).optional(),
});
export type BotSecretMetadata = z.infer<typeof BotSecretMetadata>;
export const EditableBotSecretMetadata = BotSecretMetadata.extend({
  revision: BotSecretRevision,
});

export const SecretHttpRequest = z
  .object({
    name: BotSecretName,
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    body: z.string().max(100_000).optional(),
    contentType: z
      .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
      .default("application/json"),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
