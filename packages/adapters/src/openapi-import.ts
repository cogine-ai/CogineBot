import { isDeepStrictEqual } from "node:util";
import type {
  OpenApiImportCounts,
  OpenApiImportDiagnostic,
  OpenApiImportDiagnosticCode,
} from "@rakazo/contracts";
import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseAllDocuments } from "yaml";
import {
  asRecord,
  assertNoSensitiveQuery,
  HeaderName,
  isSensitiveHeader,
  isTransportHeader,
} from "./connector-http.js";

export type { OpenApiImportCounts, OpenApiImportDiagnostic, OpenApiImportDiagnosticCode };

export type CompiledOpenApiOperation = {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  queryParameters: string[];
  headerParameters: string[];
  importPolicy: "openapi-v1";
};

export class OpenApiCompileError extends Error {
  constructor(readonly code: OpenApiImportDiagnosticCode) {
    super(`OpenAPI import failed: ${code}`);
    this.name = "OpenApiCompileError";
  }
}

const methods = ["get", "post", "put", "patch", "delete"] as const;
const httpMethods = [...methods, "head", "options", "trace"] as const;
const unsafePropertyNames = new Set(["__proto__", "constructor", "prototype"]);
const validators = new WeakMap<Record<string, unknown>, ValidateFunction>();
const stringFormats = [
  "date",
  "time",
  "date-time",
  "uuid",
  "email",
  "uri",
  "uri-reference",
  "hostname",
  "ipv4",
  "ipv6",
] as const;
const formatMaxLength = 4096;
const floatMax = (2 - 2 ** -23) * 2 ** 127;
const numberFormats: Record<string, { minimum: number; maximum: number; integer: boolean }> = {
  int32: { minimum: -2_147_483_648, maximum: 2_147_483_647, integer: true },
  int64: { minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, integer: true },
  float: { minimum: -floatMax, maximum: floatMax, integer: false },
  double: { minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE, integer: false },
};

function containsUrlControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function assertOpenApiArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  if (!validatorFor(schema)(args))
    throw new Error("OpenAPI arguments do not match the operation schema");
}

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  let validate = validators.get(schema);
  if (!validate) {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: false,
      validateFormats: true,
      ownProperties: true,
      addUsedSchema: false,
    });
    for (const name of stringFormats) {
      const format = addFormats.default.get(name, "full");
      const implementation =
        typeof format === "object" && !(format instanceof RegExp) ? format.validate : format;
      if (!(implementation instanceof RegExp) && typeof implementation !== "function")
        throw new OpenApiCompileError("unsafe_schema");
      const validate =
        implementation instanceof RegExp
          ? (value: string) => implementation.test(value)
          : (implementation as (value: string) => boolean);
      ajv.addFormat(name, {
        type: "string",
        validate: (value: string) => value.length <= formatMaxLength && validate(value),
      });
    }
    for (const [name, format] of Object.entries(numberFormats))
      ajv.addFormat(name, {
        type: "number",
        validate: (value: number) =>
          Number.isFinite(value) &&
          value >= format.minimum &&
          value <= format.maximum &&
          (!format.integer || Number.isInteger(value)),
      });
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  return validate;
}

export function parseOpenApiText(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > 2_000_000) throw new OpenApiCompileError("document_limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      const documents = parseAllDocuments(text, { uniqueKeys: false, logLevel: "silent" });
      if (documents.length !== 1) throw new OpenApiCompileError("multiple_documents");
      const document = documents[0]!;
      if (document.errors.length) throw new OpenApiCompileError("parse_error");
      value = document.toJS({ maxAliasCount: 100 });
    } catch (error) {
      if (error instanceof OpenApiCompileError) throw error;
      throw new OpenApiCompileError("parse_error");
    }
  }
  if (!asRecord(value)) throw new OpenApiCompileError("invalid_document");
  assertDocumentShape(value);
  return value as Record<string, unknown>;
}

function assertDocumentShape(value: unknown): void {
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; depth: number; leave?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.leave) {
      ancestors.delete(frame.value as object);
      continue;
    }
    if (++nodes > 100_000 || frame.depth > 64) throw new OpenApiCompileError("document_limit");
    if (frame.value && typeof frame.value === "object") {
      if (ancestors.has(frame.value)) throw new OpenApiCompileError("invalid_document");
      ancestors.add(frame.value);
      stack.push({ ...frame, leave: true });
      for (const child of Object.values(frame.value))
        stack.push({ value: child, depth: frame.depth + 1 });
    } else if (typeof frame.value === "number" && !Number.isFinite(frame.value)) {
      throw new OpenApiCompileError("invalid_document");
    }
  }
}

export function compileOpenApiDocument(document: unknown): {
  baseUrl: string;
  operations: CompiledOpenApiOperation[];
  diagnostics: OpenApiImportDiagnostic[];
  counts: OpenApiImportCounts;
} {
  const root = asRecord(document);
  if (!root) throw new OpenApiCompileError("invalid_document");
  assertDocumentShape(root);
  if (
    root.openapi !== undefined &&
    (typeof root.openapi !== "string" || !/^3\.[01]\.\d+$/.test(root.openapi))
  )
    throw new OpenApiCompileError("unsupported_version");
  if (root.swagger !== undefined) throw new OpenApiCompileError("unsupported_version");
  const server = Array.isArray(root.servers) ? asRecord(root.servers[0]) : undefined;
  if (typeof server?.url !== "string" || !server.url)
    throw new OpenApiCompileError("invalid_server");
  const rawBaseUrl = server.url;
  let baseUrl: string;
  try {
    encodeURIComponent(rawBaseUrl);
    const absolute = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(rawBaseUrl);
    if (
      !absolute ||
      rawBaseUrl.startsWith(" ") ||
      rawBaseUrl.endsWith(" ") ||
      containsUrlControl(rawBaseUrl) ||
      rawBaseUrl.includes("\\") ||
      (absolute[1] ?? "").split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
    )
      throw new Error();
    const url = new URL(rawBaseUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[{}]/.test(rawBaseUrl) ||
      server.variables !== undefined
    )
      throw new Error();
    baseUrl = url.href;
  } catch {
    throw new OpenApiCompileError("invalid_server");
  }
  assertNoSensitiveQuery(baseUrl);
  const paths = asRecord(root.paths);
  if (!paths) throw new OpenApiCompileError("invalid_document");
  const operations: CompiledOpenApiOperation[] = [];
  const diagnostics: OpenApiImportDiagnostic[] = [];
  const counts: OpenApiImportCounts = {
    discovered: 0,
    accepted: 0,
    rejected: 0,
    omittedDiagnostics: 0,
  };
  const idCounts = new Map<string, number>();
  for (const item of Object.values(paths))
    for (const method of methods) {
      const id = asRecord(asRecord(item)?.[method])?.operationId;
      if (typeof id === "string") idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  for (const [path, pathValue] of Object.entries(paths)) {
    if (path.startsWith("x-")) continue;
    const item = asRecord(pathValue);
    if (!item) continue;
    if (Object.hasOwn(item, "$ref")) {
      counts.discovered++;
      counts.rejected++;
      const code =
        typeof item.$ref === "string" && !item.$ref.startsWith("#")
          ? "external_reference"
          : "invalid_operation";
      if (diagnostics.length < 100)
        diagnostics.push({ scope: "operation", code, ...(path.length <= 2048 ? { path } : {}) });
      else counts.omittedDiagnostics++;
      continue;
    }
    for (const method of httpMethods) {
      const operation = asRecord(item[method]);
      if (!Object.hasOwn(item, method)) continue;
      counts.discovered++;
      const id = typeof operation?.operationId === "string" ? operation.operationId : undefined;
      try {
        if (!methods.includes(method as (typeof methods)[number]))
          throw new OpenApiCompileError("unsupported_method");
        if (!operation) throw new OpenApiCompileError("invalid_operation");
        if (!id || id.length > 160 || !path.startsWith("/") || path.length > 2048) {
          throw new OpenApiCompileError("invalid_operation");
        }
        try {
          encodeURIComponent(path);
        } catch {
          throw new OpenApiCompileError("invalid_operation");
        }
        if (
          containsUrlControl(path) ||
          path.includes("\\") ||
          path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
        )
          throw new OpenApiCompileError("invalid_operation");
        if ((idCounts.get(id) ?? 0) > 1) throw new OpenApiCompileError("duplicate_operation");
        if (operations.length >= 100) throw new OpenApiCompileError("operation_limit");
        if (item.servers !== undefined || operation.servers !== undefined)
          throw new OpenApiCompileError("invalid_server");
        const parameters = new Map<string, Record<string, unknown>>();
        for (const list of [item.parameters, operation.parameters]) {
          if (list === undefined) continue;
          if (!Array.isArray(list)) throw new OpenApiCompileError("invalid_parameter");
          const level = new Set<string>();
          for (const value of list) {
            const parameter = asRecord(dereference(root, value));
            if (!parameter || typeof parameter.name !== "string")
              throw new OpenApiCompileError("invalid_parameter");
            const key = `${parameter.in}:${parameter.name}`;
            if (level.has(key)) throw new OpenApiCompileError("invalid_parameter");
            level.add(key);
            parameters.set(key, parameter);
          }
        }
        const properties: Record<string, unknown> = {};
        const schemaContext = { root, work: 0, bytes: 0, requestReadOnly: false };
        const required: string[] = [];
        const queryParameters: string[] = [];
        const headerParameters: string[] = [];
        const headerNames = new Set<string>();
        for (const parameter of parameters.values()) {
          const name = parameter.name as string;
          try {
            encodeURIComponent(name);
          } catch {
            throw new OpenApiCompileError("invalid_parameter");
          }
          if (
            !name ||
            name.length > 120 ||
            unsafePropertyNames.has(name) ||
            Object.hasOwn(properties, name)
          )
            throw new OpenApiCompileError("invalid_parameter");
          if (!["path", "query", "header"].includes(String(parameter.in)))
            throw new OpenApiCompileError("unsupported_parameter");
          if (
            parameter.content !== undefined ||
            parameter.allowReserved === true ||
            parameter.allowEmptyValue === true
          )
            throw new OpenApiCompileError("unsupported_parameter");
          const isQuery = parameter.in === "query";
          if (
            (parameter.style !== undefined && parameter.style !== (isQuery ? "form" : "simple")) ||
            (parameter.explode !== undefined && parameter.explode !== isQuery)
          )
            throw new OpenApiCompileError("unsupported_parameter");
          const schema = compileSchema(schemaContext, parameter.schema);
          const scalar = ["string", "number", "integer", "boolean"].includes(String(schema.type));
          const queryArray =
            isQuery &&
            schema.type === "array" &&
            ["string", "number", "integer", "boolean"].includes(
              String(asRecord(schema.items)?.type),
            );
          if (!scalar && !queryArray) throw new OpenApiCompileError("unsupported_parameter");
          if (parameter.in === "path" && parameter.required !== true)
            throw new OpenApiCompileError("invalid_parameter");
          if (parameter.required !== undefined && typeof parameter.required !== "boolean")
            throw new OpenApiCompileError("invalid_parameter");
          if (parameter.in === "header") {
            if (
              !HeaderName.safeParse(name).success ||
              isSensitiveHeader(name) ||
              isTransportHeader(name)
            )
              throw new OpenApiCompileError("unsafe_header");
            if (headerNames.has(name.toLowerCase()))
              throw new OpenApiCompileError("invalid_parameter");
            headerNames.add(name.toLowerCase());
            headerParameters.push(name);
          }
          if (parameter.in === "query") queryParameters.push(name);
          Object.defineProperty(properties, name, {
            value: schema,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          if (parameter.required === true) required.push(name);
        }
        const requestBody = asRecord(dereference(root, operation.requestBody));
        if (operation.requestBody !== undefined && !requestBody)
          throw new OpenApiCompileError("unsupported_parameter");
        if (requestBody) {
          if (method === "get" || method === "delete")
            throw new OpenApiCompileError("unsupported_parameter");
          if (Object.hasOwn(properties, "body")) throw new OpenApiCompileError("invalid_parameter");
          if (requestBody.required !== undefined && typeof requestBody.required !== "boolean")
            throw new OpenApiCompileError("invalid_parameter");
          const content = asRecord(requestBody.content);
          const json = asRecord(content?.["application/json"]);
          if (!json || !content || Object.keys(content).length !== 1 || json.encoding !== undefined)
            throw new OpenApiCompileError("unsupported_parameter");
          if (headerNames.has("content-type")) throw new OpenApiCompileError("unsafe_header");
          schemaContext.requestReadOnly =
            typeof root.openapi === "string" && root.openapi.startsWith("3.0.");
          properties.body = compileSchema(schemaContext, json.schema);
          if (requestBody?.required === true) required.push("body");
        }
        const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
        if (
          path.replace(/\{[^{}]+\}/g, "").match(/[{}?#]/) ||
          placeholders.some((name) => !parameters.has(`path:${name}`)) ||
          [...parameters.values()].some(
            (parameter) =>
              parameter.in === "path" && !placeholders.includes(parameter.name as string),
          )
        )
          throw new OpenApiCompileError("invalid_parameter");
        const inputSchema = {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        };
        if (Buffer.byteLength(JSON.stringify(inputSchema), "utf8") > 20_000)
          throw new OpenApiCompileError("schema_limit");
        try {
          validatorFor(inputSchema);
        } catch {
          throw new OpenApiCompileError("unsafe_schema");
        }
        operations.push({
          id,
          name: id,
          description:
            typeof operation.description === "string"
              ? operation.description.slice(0, 2000)
              : typeof operation.summary === "string"
                ? operation.summary.slice(0, 2000)
                : `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase() as CompiledOpenApiOperation["method"],
          path,
          inputSchema,
          readOnly: method === "get",
          queryParameters,
          headerParameters,
          importPolicy: "openapi-v1",
        });
        counts.accepted++;
      } catch (error) {
        if (!(error instanceof OpenApiCompileError)) throw error;
        counts.rejected++;
        if (diagnostics.length < 100)
          diagnostics.push({
            scope: "operation",
            code: error.code,
            ...(id && id.length <= 160 ? { operationId: id } : {}),
            method: method.toUpperCase(),
            ...(path.length <= 2048 ? { path } : {}),
          });
        else counts.omittedDiagnostics++;
      }
    }
  }
  if (counts.discovered === 0) diagnostics.push({ scope: "document", code: "invalid_operation" });
  return { baseUrl, operations, diagnostics, counts };
}

function dereference(root: Record<string, unknown>, value: unknown, seen: string[] = []): unknown {
  const record = asRecord(value);
  if (!record || !Object.hasOwn(record, "$ref")) return value;
  if (typeof record.$ref !== "string") throw new OpenApiCompileError("unresolved_reference");
  if (
    Object.keys(record).some(
      (key) => !["$ref", "summary", "description"].includes(key) && !key.startsWith("x-"),
    )
  )
    throw new OpenApiCompileError("invalid_parameter");
  const ref = record.$ref;
  if (!ref.startsWith("#")) throw new OpenApiCompileError("external_reference");
  if (seen.includes(ref)) throw new OpenApiCompileError("reference_cycle");
  if (seen.length >= 8) throw new OpenApiCompileError("reference_depth");
  return dereference(root, referenceTarget(root, ref), [...seen, ref]);
}

function referenceTarget(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#")) throw new OpenApiCompileError("external_reference");
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    throw new OpenApiCompileError("unresolved_reference");
  }
  if (pointer && !pointer.startsWith("/")) throw new OpenApiCompileError("unresolved_reference");
  let current: unknown = root;
  for (const encoded of pointer ? pointer.slice(1).split("/") : []) {
    if (/~(?:[^01]|$)/.test(encoded)) throw new OpenApiCompileError("unresolved_reference");
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      throw new OpenApiCompileError("unresolved_reference");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

type SchemaContext = {
  root: Record<string, unknown>;
  work: number;
  bytes: number;
  requestReadOnly: boolean;
};
const annotations = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$comment",
]);
const lowerBounds = new Set([
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
]);
const upperBounds = new Set([
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
]);
const keywords = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "enum",
  "const",
  "multipleOf",
  "uniqueItems",
  "format",
  ...lowerBounds,
  ...upperBounds,
]);

function charge(context: SchemaContext, value: unknown): void {
  if (++context.work > 20_000) throw new OpenApiCompileError("schema_limit");
  context.bytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") + 4 : 8;
  if (context.bytes > 100_000) throw new OpenApiCompileError("schema_limit");
}

function literal(context: SchemaContext, value: unknown, depth: number): unknown {
  charge(context, value);
  if (depth > 64) throw new OpenApiCompileError("schema_limit");
  if (Array.isArray(value)) return value.map((item) => literal(context, item, depth + 1));
  const record = asRecord(value);
  return record
    ? Object.fromEntries(
        Object.entries(record).map(([key, child]) => {
          charge(context, key);
          return [key, literal(context, child, depth + 1)];
        }),
      )
    : value;
}

function compileSchema(context: SchemaContext, value: unknown): Record<string, unknown> {
  const expanded = expandSchema(context, value, [], 0);
  const validated = validateSchema(expanded);
  if (context.requestReadOnly) projectRequestSchema(context, validated);
  return validated;
}

function requestPropertyReadOnly(
  schema: Record<string, unknown>,
  inheritedReadOnly = false,
  inheritedWriteOnly = false,
): boolean {
  const readOnly = inheritedReadOnly || schema.readOnly === true;
  const writeOnly = inheritedWriteOnly || schema.writeOnly === true;
  if (readOnly && writeOnly) throw new OpenApiCompileError("unsafe_schema");
  const variants = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(variants)) return readOnly;
  const states = variants.map((variant) =>
    requestPropertyReadOnly(variant as Record<string, unknown>, readOnly, writeOnly),
  );
  if (states.some((state) => state !== states[0])) throw new OpenApiCompileError("unsafe_schema");
  return states[0]!;
}

function projectRequestSchema(context: SchemaContext, schema: Record<string, unknown>): void {
  charge(context, schema);
  for (const key of ["oneOf", "anyOf"])
    for (const variant of (schema[key] as Record<string, unknown>[] | undefined) ?? [])
      projectRequestSchema(context, variant);
  const properties = asRecord(schema.properties);
  if (properties) {
    const forbidden: string[] = [];
    for (const [name, value] of Object.entries(properties)) {
      const child = value as Record<string, unknown>;
      const readOnly = requestPropertyReadOnly(child);
      projectRequestSchema(context, child);
      if (readOnly) {
        charge(context, name);
        forbidden.push(name);
        delete properties[name];
      }
    }
    if (forbidden.length) {
      const blocked = new Set(forbidden);
      if (Array.isArray(schema.required)) {
        const required = schema.required.filter((name) => !blocked.has(name));
        if (required.length) schema.required = required;
        else delete schema.required;
      }
      schema.not = {
        type: "object",
        anyOf: forbidden.map((name) => ({ required: [name] })),
      };
    }
  }
  const items = asRecord(schema.items);
  if (items) projectRequestSchema(context, items);
}

function expandSchema(
  context: SchemaContext,
  value: unknown,
  chain: string[],
  depth: number,
): Record<string, unknown> {
  charge(context, value);
  if (depth > 64) throw new OpenApiCompileError("schema_limit");
  const schema = asRecord(value);
  if (!schema) throw new OpenApiCompileError("unsafe_schema");
  if (
    ["readOnly", "writeOnly"].some(
      (key) => schema[key] !== undefined && typeof schema[key] !== "boolean",
    )
  )
    throw new OpenApiCompileError("unsafe_schema");
  let result: Record<string, unknown> = {};
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") throw new OpenApiCompileError("unresolved_reference");
    if (chain.includes(schema.$ref)) throw new OpenApiCompileError("reference_cycle");
    if (chain.length >= 8) throw new OpenApiCompileError("reference_depth");
    result = expandSchema(
      context,
      referenceTarget(context.root, schema.$ref),
      [...chain, schema.$ref],
      depth + 1,
    );
  }
  const own: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    charge(context, key);
    if (key === "$ref" || key === "allOf") continue;
    let next: unknown;
    if (key === "properties") {
      const fields = asRecord(child);
      if (!fields) throw new OpenApiCompileError("unsafe_schema");
      next = Object.fromEntries(
        Object.entries(fields).map(([name, spec]) => {
          if (unsafePropertyNames.has(name)) throw new OpenApiCompileError("unsafe_schema");
          charge(context, name);
          return [name, expandSchema(context, spec, chain, depth + 1)];
        }),
      );
    } else if (key === "items") {
      next = expandSchema(context, child, chain, depth + 1);
    } else if (key === "oneOf" || key === "anyOf") {
      if (!Array.isArray(child) || !child.length || child.length > 20)
        throw new OpenApiCompileError("unsafe_schema");
      next = child.map((variant) => expandSchema(context, variant, chain, depth + 1));
    } else if (keywords.has(key) || annotations.has(key) || key.startsWith("x-")) {
      next = literal(context, child, depth + 1);
    } else {
      throw new OpenApiCompileError("unsafe_schema");
    }
    Object.defineProperty(own, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  result = intersectSchemas(result, own, context.requestReadOnly);
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || !schema.allOf.length || schema.allOf.length > 20)
      throw new OpenApiCompileError("unsafe_schema");
    for (const child of schema.allOf)
      result = intersectSchemas(
        result,
        expandSchema(context, child, chain, depth + 1),
        context.requestReadOnly,
      );
  }
  return result;
}

function intersectSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  requestReadOnly: boolean,
): Record<string, unknown> {
  for (const [closed, other] of [
    [left, right],
    [right, left],
  ]) {
    if (closed!.additionalProperties === false) {
      const known = asRecord(closed!.properties) ?? {};
      if (Object.keys(asRecord(other!.properties) ?? {}).some((key) => !Object.hasOwn(known, key)))
        throw new OpenApiCompileError("unsafe_schema");
    }
  }
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const current = Object.hasOwn(merged, key) ? merged[key] : undefined;
    let next = value;
    if (requestReadOnly && (key === "readOnly" || key === "writeOnly") && current === true)
      next = true;
    else if (
      current !== undefined &&
      !isDeepStrictEqual(current, value) &&
      !annotations.has(key) &&
      !key.startsWith("x-")
    ) {
      if (key === "required" && Array.isArray(current) && Array.isArray(value))
        next = [...new Set([...current, ...value])];
      else if (key === "enum" && Array.isArray(current) && Array.isArray(value)) {
        next = current.filter((entry) =>
          value.some((candidate) => isDeepStrictEqual(entry, candidate)),
        );
        if (!(next as unknown[]).length) throw new OpenApiCompileError("unsafe_schema");
      } else if (
        (lowerBounds.has(key) || upperBounds.has(key)) &&
        typeof current === "number" &&
        typeof value === "number"
      ) {
        next = lowerBounds.has(key) ? Math.max(current, value) : Math.min(current, value);
      } else if (
        key === "type" &&
        [current, value].every((type) => type === "number" || type === "integer")
      )
        next = "integer";
      else if (key === "items" && asRecord(current) && asRecord(value))
        next = intersectSchemas(
          current as Record<string, unknown>,
          value as Record<string, unknown>,
          requestReadOnly,
        );
      else if (key === "properties" && asRecord(current) && asRecord(value)) {
        const properties = { ...(current as Record<string, unknown>) };
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
          const existing = Object.hasOwn(properties, name) ? asRecord(properties[name]) : undefined;
          Object.defineProperty(properties, name, {
            value: existing
              ? intersectSchemas(existing, child as Record<string, unknown>, requestReadOnly)
              : child,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        next = properties;
      } else if (
        key === "additionalProperties" &&
        typeof current === "boolean" &&
        typeof value === "boolean"
      )
        next = current && value;
      else throw new OpenApiCompileError("unsafe_schema");
    }
    Object.defineProperty(merged, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (
    Object.hasOwn(merged, "const") &&
    Array.isArray(merged.enum) &&
    !merged.enum.some((value) => isDeepStrictEqual(value, merged.const))
  )
    throw new OpenApiCompileError("unsafe_schema");
  return merged;
}

function validateSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema.type;
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants !== undefined) {
    if (schema.oneOf !== undefined && schema.anyOf !== undefined)
      throw new OpenApiCompileError("unsafe_schema");
    if (
      Object.keys(schema).some(
        (key) =>
          key !== "oneOf" && key !== "anyOf" && !annotations.has(key) && !key.startsWith("x-"),
      )
    )
      throw new OpenApiCompileError("unsafe_schema");
    for (const variant of variants as Record<string, unknown>[]) validateSchema(variant);
    return schema;
  }
  let types = Array.isArray(type) ? type : [type];
  if (
    !types.length ||
    types.some(
      (entry) =>
        !["string", "number", "integer", "boolean", "null", "object", "array"].includes(
          String(entry),
        ),
    )
  )
    throw new OpenApiCompileError("unsafe_schema");
  if (types.length > 1 && (types.length !== 2 || !types.includes("null")))
    throw new OpenApiCompileError("unsafe_schema");
  if (schema.format !== undefined) {
    if (typeof schema.format !== "string") throw new OpenApiCompileError("unsafe_schema");
    if (stringFormats.includes(schema.format as (typeof stringFormats)[number])) {
      if (
        !types.includes("string") ||
        (schema.maxLength !== undefined && typeof schema.maxLength !== "number")
      )
        throw new OpenApiCompileError("unsafe_schema");
      schema.maxLength =
        typeof schema.maxLength === "number"
          ? Math.min(schema.maxLength, formatMaxLength)
          : formatMaxLength;
    } else {
      const format = Object.hasOwn(numberFormats, schema.format)
        ? numberFormats[schema.format]
        : undefined;
      if (
        !format ||
        !types.some((type) => type === "number" || type === "integer") ||
        ["minimum", "maximum"].some(
          (key) => schema[key] !== undefined && typeof schema[key] !== "number",
        )
      )
        throw new OpenApiCompileError("unsafe_schema");
      schema.minimum = Math.max(
        typeof schema.minimum === "number" ? schema.minimum : -Infinity,
        format.minimum,
      );
      schema.maximum = Math.min(
        typeof schema.maximum === "number" ? schema.maximum : Infinity,
        format.maximum,
      );
      if (format.integer) {
        types = types.map((type) => (type === "number" ? "integer" : type));
        schema.type = Array.isArray(type) ? types : types[0];
      }
    }
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.length ||
      schema.enum.some((value) => value !== null && typeof value === "object"))
  )
    throw new OpenApiCompileError("unsafe_schema");
  const matchesType = (value: unknown) =>
    types.some((type) =>
      type === "null"
        ? value === null
        : type === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : type === "number"
            ? typeof value === "number"
            : typeof value === type,
    );
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum.filter(matchesType);
    if (!allowed.length) throw new OpenApiCompileError("unsafe_schema");
    schema.enum = allowed;
  }
  if (Object.hasOwn(schema, "const") && !matchesType(schema.const))
    throw new OpenApiCompileError("unsafe_schema");
  if (Object.hasOwn(schema, "const") && schema.const !== null && typeof schema.const === "object")
    throw new OpenApiCompileError("unsafe_schema");
  for (const key of [...lowerBounds, ...upperBounds, "multipleOf"]) {
    const value = schema[key];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (key === "multipleOf"
          ? value <= 0
          : (key.includes("Length") || key.includes("Items") || key.includes("Properties")) &&
            (!Number.isInteger(value) || value < 0)))
    )
      throw new OpenApiCompileError("unsafe_schema");
  }
  for (const [min, max] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
    ["minimum", "maximum"],
  ]) {
    if (
      typeof schema[min!] === "number" &&
      typeof schema[max!] === "number" &&
      (schema[min!] as number) > (schema[max!] as number)
    )
      throw new OpenApiCompileError("unsafe_schema");
  }
  const lower = Math.max(
    typeof schema.minimum === "number" ? schema.minimum : -Infinity,
    typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : -Infinity,
  );
  const upper = Math.min(
    typeof schema.maximum === "number" ? schema.maximum : Infinity,
    typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : Infinity,
  );
  if (
    lower > upper ||
    (lower === upper && (schema.exclusiveMinimum === lower || schema.exclusiveMaximum === upper))
  )
    throw new OpenApiCompileError("unsafe_schema");
  if (types.includes("object")) {
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties !== "boolean"
    )
      throw new OpenApiCompileError("unsafe_schema");
    const properties = asRecord(schema.properties) ?? {};
    if (schema.properties !== undefined && !asRecord(schema.properties))
      throw new OpenApiCompileError("unsafe_schema");
    for (const child of Object.values(properties)) validateSchema(child as Record<string, unknown>);
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)))
    )
      throw new OpenApiCompileError("unsafe_schema");
  } else if (
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined
  )
    throw new OpenApiCompileError("unsafe_schema");
  if (types.includes("array")) {
    if (!asRecord(schema.items)) throw new OpenApiCompileError("unsafe_schema");
    validateSchema(schema.items as Record<string, unknown>);
    if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean")
      throw new OpenApiCompileError("unsafe_schema");
  } else if (schema.items !== undefined || schema.uniqueItems !== undefined)
    throw new OpenApiCompileError("unsafe_schema");
  return schema;
}
