import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { DEFAULT_MAX_BYTES } from "../../../lib/config";
import { readLimitedBytes, withHardTimeout } from "../../../lib/http";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

const gunzipAsync = promisify(gunzip);

interface RustdocCrate {
  root: number;
  crate_version: string | null;
  index: Record<string, RustdocItem>;
  paths: Record<string, { crate_id: number; path: string[]; kind: string }>;
  format_version: number;
}

interface RustdocItem {
  name: string | null;
  docs: string | null;
  inner: Record<string, unknown>;
  visibility: string | { restricted: { parent: number; path: string } };
  deprecation: { since: string | null; note: string | null } | null;
}

interface FunctionData {
  sig: { inputs: [string, RustType][]; output: RustType | null };
  generics: Generics;
  has_body: boolean;
  is_async: boolean;
  is_unsafe: boolean;
  is_const: boolean;
}

interface Generics {
  params: GenericParam[];
}

interface GenericParam {
  name: string;
  kind: Record<string, unknown>;
}

type RustType = Record<string, unknown>;

interface DocsRsTarget {
  crateName: string;
  version: string;
  modulePath: string[];
  itemKind: string | null;
  itemName: string | null;
}

/** Parse a docs.rs rustdoc URL into its target. Exported for tests. */
export function parseDocsRsUrl(url: string): DocsRsTarget | null {
  const parsed = new URL(url);
  if (parsed.hostname !== "docs.rs") return null;

  const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments[0] === "crate") return null;
  if (segments.length < 3) return null;

  const crateName = segments[0]!;
  const version = segments[1]!;
  const rest = segments.slice(2);
  let itemKind: string | null = null;
  let itemName: string | null = null;

  const last = rest[rest.length - 1];
  const itemMatch = last?.match(
    /^(struct|trait|fn|enum|macro|type|constant|static|attr|derive|union|primitive)\.(.+)\.html$/,
  );
  if (itemMatch) {
    itemKind = itemMatch[1]!;
    itemName = itemMatch[2]!;
    rest.pop();
  } else if (last === "index.html") {
    rest.pop();
  }

  return { crateName, version, modulePath: rest, itemKind, itemName };
}

function renderType(ty: RustType | null | undefined, depth = 0): string {
  if (!ty || depth > 10) return "_";
  if (typeof ty === "string") return ty;
  if ("generic" in ty) return ty.generic as string;
  if ("primitive" in ty) return ty.primitive as string;
  if ("infer" in ty) return "_";
  if ("resolved_path" in ty) {
    const rp = ty.resolved_path as {
      path: string;
      args?: { angle_bracketed?: { args: unknown[] } };
    };
    const args = rp.args?.angle_bracketed?.args;
    if (args?.length) {
      const rendered = args
        .map((arg: unknown) => {
          if (typeof arg === "object" && arg !== null && "type" in arg) {
            return renderType((arg as { type: RustType }).type, depth + 1);
          }
          if (typeof arg === "object" && arg !== null && "lifetime" in arg) {
            return `'${(arg as { lifetime: string }).lifetime}`;
          }
          return "_";
        })
        .join(", ");
      return `${rp.path}<${rendered}>`;
    }
    return rp.path;
  }
  if ("borrowed_ref" in ty) {
    const br = ty.borrowed_ref as { lifetime: string | null; is_mutable: boolean; type: RustType };
    return `&${br.lifetime ? `'${br.lifetime} ` : ""}${br.is_mutable ? "mut " : ""}${renderType(br.type, depth + 1)}`;
  }
  if ("tuple" in ty)
    return `(${(ty.tuple as RustType[]).map((item) => renderType(item, depth + 1)).join(", ")})`;
  if ("slice" in ty) return `[${renderType(ty.slice as RustType, depth + 1)}]`;
  if ("array" in ty) {
    const arr = ty.array as { type: RustType; len: string };
    return `[${renderType(arr.type, depth + 1)}; ${arr.len}]`;
  }
  if ("raw_pointer" in ty) {
    const rp = ty.raw_pointer as { is_mutable: boolean; type: RustType };
    return `*${rp.is_mutable ? "mut" : "const"} ${renderType(rp.type, depth + 1)}`;
  }
  if ("qualified_path" in ty) {
    const qp = ty.qualified_path as { name: string; self_type: RustType; trait_: RustType | null };
    const selfType = renderType(qp.self_type, depth + 1);
    return qp.trait_
      ? `<${selfType} as ${renderType(qp.trait_, depth + 1)}>::${qp.name}`
      : `${selfType}::${qp.name}`;
  }
  if ("impl_trait" in ty) {
    const bounds = ty.impl_trait as Array<{ trait_bound?: { trait: RustType } }>;
    return `impl ${bounds.map((bound) => (bound.trait_bound ? renderType(bound.trait_bound.trait, depth + 1) : "?")).join(" + ")}`;
  }
  if ("dyn_trait" in ty) {
    const dt = ty.dyn_trait as { traits: Array<{ trait: RustType }>; lifetime: string | null };
    const parts = dt.traits.map((entry) => renderType(entry.trait, depth + 1)).join(" + ");
    return `dyn ${parts}${dt.lifetime ? ` + '${dt.lifetime}` : ""}`;
  }
  if ("function_pointer" in ty) return "fn(...)";
  return "_";
}

function renderGenerics(generics: Generics): string {
  const params = generics.params
    .filter((param) => param.kind && !("lifetime" in param.kind))
    .map((param) => param.name);
  return params.length ? `<${params.join(", ")}>` : "";
}

function renderFunctionSig(name: string, fn: FunctionData, generics?: Generics): string {
  const parts: string[] = [];
  if (fn.is_const) parts.push("const");
  if (fn.is_async) parts.push("async");
  if (fn.is_unsafe) parts.push("unsafe");
  parts.push("fn");
  const gen = generics ? renderGenerics(generics) : renderGenerics(fn.generics);
  const inputs = fn.sig.inputs
    .map(([argName, ty]) => (argName === "self" ? renderType(ty) : `${argName}: ${renderType(ty)}`))
    .join(", ");
  const output = fn.sig.output ? ` -> ${renderType(fn.sig.output)}` : "";
  return `${parts.join(" ")} ${name}${gen}(${inputs})${output}`;
}

function renderItemDecl(item: RustdocItem): string | null {
  const inner = item.inner;
  if ("function" in inner)
    return renderFunctionSig(item.name ?? "?", inner.function as FunctionData);
  if ("struct" in inner) {
    const data = inner.struct as { generics: Generics };
    return `struct ${item.name}${renderGenerics(data.generics)}`;
  }
  if ("enum" in inner) {
    const data = inner.enum as { generics: Generics };
    return `enum ${item.name}${renderGenerics(data.generics)}`;
  }
  if ("trait" in inner) {
    const data = inner.trait as { generics: Generics; is_unsafe: boolean };
    return `${data.is_unsafe ? "unsafe " : ""}trait ${item.name}${renderGenerics(data.generics)}`;
  }
  if ("type_alias" in inner) {
    const data = inner.type_alias as { generics: Generics; type: RustType | null };
    return `type ${item.name}${renderGenerics(data.generics)}${data.type ? ` = ${renderType(data.type)}` : ""}`;
  }
  if ("macro_def" in inner) return `macro ${item.name}!(...)`;
  if ("constant" in inner) {
    const data = inner.constant as { type: RustType; value: string | null };
    return `const ${item.name}: ${renderType(data.type)}${data.value ? ` = ${data.value}` : ""}`;
  }
  return null;
}

function itemKindFromInner(inner: Record<string, unknown>): string {
  return Object.keys(inner)[0] ?? "unknown";
}

function findItemInModule(
  module: RustdocItem,
  name: string,
  index: Record<string, RustdocItem>,
): RustdocItem | null {
  const items = (module.inner?.module as { items: number[] } | undefined)?.items;
  if (!items) return null;
  for (const id of items) {
    const item = index[String(id)];
    if (!item) continue;
    if (item.name === name) return item;
    if ("use" in item.inner) {
      const useData = item.inner.use as { name: string; id: number | null };
      if (useData.name === name && useData.id != null) {
        const target = index[String(useData.id)];
        if (target) return target;
      }
    }
  }
  return null;
}

/** Hard ceiling for decompressed rustdoc JSON. */
export const MAX_RUSTDOC_GUNZIP_BYTES = 256 * 1024 * 1024;

interface CachedRustdoc {
  crate: RustdocCrate;
  fetchedAt: string;
}

function cachePath(target: DocsRsTarget, cacheDir: string): string {
  const crate = target.crateName.replace(/[^A-Za-z0-9._-]+/g, "_");
  const version =
    target.version !== "latest"
      ? target.version.replace(/[^A-Za-z0-9._-]+/g, "_")
      : new Date().toISOString().slice(0, 10);
  return join(cacheDir, `docsrs_${crate}_${version}`, "rustdoc.json");
}

function readCache(path: string): CachedRustdoc | null {
  try {
    const crate = parseJson<RustdocCrate>(readFileSync(path, "utf-8"));
    if (!crate?.index) return null;
    return { crate, fetchedAt: statSync(path).mtime.toISOString() };
  } catch {
    return null;
  }
}

function writeCache(path: string, json: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, json, "utf-8");
  } catch {
    // Cache writes are best-effort.
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

interface RustdocImplData {
  trait?: { path: string; args?: { angle_bracketed?: { args: unknown[] } } } | null;
  items: number[];
  is_synthetic?: boolean;
  blanket_impl?: RustType | null;
}

function renderImplTrait(trait_: NonNullable<RustdocImplData["trait"]>): string {
  return renderType({ resolved_path: { path: trait_.path, args: trait_.args } });
}

function collectInherentMethods(implIds: number[], index: Record<string, RustdocItem>): string[] {
  const methods: string[] = [];
  for (const implId of implIds) {
    const impl_ = index[String(implId)];
    if (!impl_ || !("impl" in impl_.inner)) continue;
    const implData = impl_.inner.impl as RustdocImplData;
    if (implData.is_synthetic || implData.trait || implData.blanket_impl) continue;
    for (const methodId of implData.items ?? []) {
      const method = index[String(methodId)];
      if (!method?.name || !("function" in method.inner)) continue;
      const signature = renderFunctionSig(method.name, method.inner.function as FunctionData);
      methods.push(`- \`${signature}\`${method.docs ? ` — ${firstLine(method.docs)}` : ""}`);
    }
  }
  return methods;
}

function collectTraitImpls(implIds: number[], index: Record<string, RustdocItem>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const implId of implIds) {
    const impl_ = index[String(implId)];
    if (!impl_ || !("impl" in impl_.inner)) continue;
    const implData = impl_.inner.impl as RustdocImplData;
    if (implData.is_synthetic || implData.blanket_impl || !implData.trait) continue;
    const name = renderImplTrait(implData.trait);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function renderSingleItem(
  item: RustdocItem,
  index: Record<string, RustdocItem>,
  crate: RustdocCrate,
): string {
  let md = "";
  const decl = renderItemDecl(item);
  const kind = itemKindFromInner(item.inner);
  md += `# ${kind} ${item.name}\n\n`;
  if (item.deprecation)
    md += `> **Deprecated**${item.deprecation.note ? `: ${item.deprecation.note}` : ""}\n\n`;
  if (decl) md += `\`\`\`rust\n${decl}\n\`\`\`\n\n`;
  if (item.docs) md += `${item.docs}\n\n`;

  if (
    "struct" in item.inner ||
    "enum" in item.inner ||
    "trait" in item.inner ||
    "union" in item.inner
  ) {
    const impls = (item.inner[kind] as { impls?: number[]; items?: number[] })?.impls ?? [];
    const traitItems = (item.inner[kind] as { items?: number[] })?.items ?? [];

    if (traitItems.length > 0) {
      const required: string[] = [];
      const provided: string[] = [];
      for (const id of traitItems) {
        const child = index[String(id)];
        if (!child) continue;
        if ("function" in child.inner) {
          const fn_ = child.inner.function as FunctionData;
          const line = `- \`${renderFunctionSig(child.name ?? "?", fn_)}\`${child.docs ? ` — ${firstLine(child.docs)}` : ""}`;
          if (fn_.has_body) provided.push(line);
          else required.push(line);
        } else if ("assoc_type" in child.inner) {
          required.push(
            `- \`type ${child.name}\`${child.docs ? ` — ${firstLine(child.docs)}` : ""}`,
          );
        }
      }
      if (required.length) md += `## Required Methods\n\n${required.join("\n")}\n\n`;
      if (provided.length) md += `## Provided Methods\n\n${provided.join("\n")}\n\n`;
    }

    const methods = collectInherentMethods(impls, index);
    if (methods.length) md += `## Methods\n\n${methods.join("\n")}\n\n`;
    const traitImpls = collectTraitImpls(impls, index);
    if (traitImpls.length)
      md += `## Trait Implementations\n\n${traitImpls.map((name) => `- ${name}`).join("\n")}\n\n`;
  }

  if ("enum" in item.inner) {
    const variants = (item.inner.enum as { variants: number[] }).variants ?? [];
    const lines: string[] = [];
    for (const id of variants) {
      const variant = index[String(id)];
      if (!variant?.name) continue;
      lines.push(`- \`${variant.name}\`${variant.docs ? ` — ${firstLine(variant.docs)}` : ""}`);
    }
    if (lines.length) md += `## Variants\n\n${lines.join("\n")}\n\n`;
  }

  if (crate.crate_version) md += `---\n*${crate.crate_version}*\n`;
  return md;
}

const KIND_ORDER = [
  "module",
  "macro_def",
  "struct",
  "enum",
  "trait",
  "function",
  "type_alias",
  "constant",
  "static",
];
const KIND_LABELS: Record<string, string> = {
  module: "Modules",
  macro_def: "Macros",
  struct: "Structs",
  enum: "Enums",
  trait: "Traits",
  function: "Functions",
  type_alias: "Type Aliases",
  constant: "Constants",
  static: "Statics",
  union: "Unions",
};

function renderModule(
  module: RustdocItem,
  index: Record<string, RustdocItem>,
  crate: RustdocCrate,
  target: DocsRsTarget,
): string {
  let md = `# ${target.modulePath.join("::")}\n\n`;
  if (module.docs) md += `${module.docs}\n\n`;

  const items = (module.inner?.module as { items: number[] } | undefined)?.items;
  if (!items) return md;

  const groups: Record<string, Array<{ name: string; docs: string; decl: string | null }>> = {};
  for (const id of items) {
    let item = index[String(id)];
    if (!item) continue;
    let displayName = item.name;
    if ("use" in item.inner) {
      const useData = item.inner.use as { name: string; id: number | null };
      displayName = useData.name;
      if (useData.id == null) continue;
      const resolved = index[String(useData.id)];
      if (!resolved) continue;
      item = resolved;
    }
    if (!displayName) continue;
    if (
      item.visibility === "crate" ||
      (typeof item.visibility === "object" && "restricted" in item.visibility)
    )
      continue;
    const kind = itemKindFromInner(item.inner);
    groups[kind] ??= [];
    groups[kind]!.push({
      name: displayName,
      docs: firstLine(item.docs ?? ""),
      decl: renderItemDecl(item),
    });
  }

  for (const kind of KIND_ORDER) {
    const group = groups[kind];
    if (!group?.length) continue;
    md += `## ${KIND_LABELS[kind] ?? kind}\n\n`;
    for (const entry of group) {
      md +=
        entry.decl && kind === "function"
          ? `- \`${entry.decl}\`${entry.docs ? ` — ${entry.docs}` : ""}\n`
          : `- **${entry.name}**${entry.docs ? ` — ${entry.docs}` : ""}\n`;
    }
    md += "\n";
  }

  if (crate.crate_version) md += `---\n*${crate.crate_version}*\n`;
  return md;
}

async function loadRustdoc(
  target: DocsRsTarget,
  ctx: Parameters<SpecialHandler>[1],
): Promise<{ crate: RustdocCrate; fetchedAt: string; notes: string[] } | null> {
  let cached: CachedRustdoc | null = null;
  const path = ctx.cacheDir ? cachePath(target, ctx.cacheDir) : undefined;
  if (path) cached = readCache(path);
  if (cached) return { ...cached, notes: ["Loaded from docs.rs rustdoc JSON cache"] };

  const fetchedAt = new Date().toISOString();
  const response = await ctx.fetch(
    `https://docs.rs/crate/${target.crateName}/${target.version}/json.gz`,
    {
      signal: withHardTimeout(ctx.signal, ctx.timeoutMs),
      headers: { Accept: "application/gzip" },
      redirect: "follow",
    },
  );
  if (!response.ok) return null;

  const { bytes } = await readLimitedBytes(response, DEFAULT_MAX_BYTES);
  const json = (
    await gunzipAsync(Buffer.from(bytes), { maxOutputLength: MAX_RUSTDOC_GUNZIP_BYTES })
  ).toString("utf-8");
  const crate = parseJson<RustdocCrate>(json);
  if (!crate?.index) return null;
  if (path) writeCache(path, json);
  return { crate, fetchedAt, notes: ["Fetched via docs.rs rustdoc JSON"] };
}

/** Handle docs.rs rustdoc URLs. */
export const handleDocsRs: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  const target = parseDocsRsUrl(url);
  if (!target) return null;

  try {
    const loaded = await loadRustdoc(target, ctx);
    if (!loaded) return null;
    const { crate, fetchedAt, notes } = loaded;

    let current = crate.index[String(crate.root)];
    if (!current) return null;
    for (const segment of target.modulePath.slice(1)) {
      const items = (current.inner?.module as { items: number[] } | undefined)?.items;
      if (!items) return null;
      const child = items
        .map((id) => crate.index[String(id)])
        .find((item) => item?.name === segment && "module" in (item?.inner ?? {}));
      if (!child) return null;
      current = child;
    }

    if (target.itemName) {
      const found = findItemInModule(current, target.itemName, crate.index);
      if (!found) return null;
      return buildResult(renderSingleItem(found, crate.index, crate), {
        url,
        method: "docs.rs",
        fetchedAt,
        notes,
      });
    }

    return buildResult(renderModule(current, crate.index, crate, target), {
      url,
      method: "docs.rs",
      fetchedAt,
      notes,
    });
  } catch {
    if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
    return null;
  }
};
