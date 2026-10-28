import path from "path"
import fs from "fs/promises"
import { $ } from "bun"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import Data from "./catalog.json"

// DeV catalog: curated skills, plugins and MCP servers that can be installed per user or per
// project. Every operation is an edit to that scope's config file (or skills folder), so the
// engine's normal config loading picks it up.

export type Scope = "user" | "project"
export type Status = "installed" | "disabled" | "bundled" | "available"

export type Entry = {
  id: string
  kind: "mcp" | "plugin" | "skill"
  name: string
  description: string
  tags: string[]
  license: string
  source: string
  bundled?: boolean
  mcp?: Record<string, unknown>
  plugin?: string
  skill?: { repo: string; ref: string; path: string }
}

export function entries() {
  return Data.entries as Entry[]
}

export function get(id: string) {
  return entries().find((entry) => entry.id === id)
}

export function search(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return entries()
  return entries()
    .map((entry) => {
      const text = [entry.id, entry.name, entry.description, ...entry.tags].join(" ").toLowerCase()
      return { entry, score: words.filter((word) => text.includes(word)).length }
    })
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map((item) => item.entry)
}

export async function status(entry: Entry, scope: Scope, root: string): Promise<Status> {
  const where = await paths(scope, root)
  if (entry.kind === "skill") {
    if (await exists(path.join(where.skills, entry.id))) return "installed"
    if (await exists(path.join(where.skills, `.${entry.id}`))) return "disabled"
    return "available"
  }
  const cfg = await readConfig(where.config)
  if (entry.kind === "mcp") {
    const item = cfg.mcp?.[entry.id]
    if (item?.enabled === false) return "disabled"
    if (item?.type) return "installed"
    return entry.bundled ? "bundled" : "available"
  }
  if (plugins(cfg).some((spec) => samePlugin(spec, entry.plugin!))) return "installed"
  return entry.bundled ? "bundled" : "available"
}

/** Installs into the scope and returns a short human-readable result. */
export async function install(entry: Entry, scope: Scope, root: string) {
  const where = await paths(scope, root)
  if (entry.kind === "mcp") {
    await edit(where.config, ["mcp", entry.id], { ...entry.mcp, enabled: true })
    return `Added MCP server ${entry.id} to ${where.config}`
  }
  if (entry.kind === "plugin") {
    const current = plugins(await readConfig(where.config))
    if (!current.some((spec) => samePlugin(spec, entry.plugin!)))
      await edit(where.config, ["plugin"], [...current, entry.plugin])
    return `Added plugin ${entry.plugin} to ${where.config}. It loads in the next session.`
  }
  const source = path.join(await fetchSkill(entry.skill!), entry.skill!.path)
  const target = path.join(where.skills, entry.id)
  await fs.rm(target, { recursive: true, force: true })
  await fs.rm(path.join(where.skills, `.${entry.id}`), { recursive: true, force: true })
  await fs.mkdir(where.skills, { recursive: true })
  await fs.cp(source, target, { recursive: true })
  const found = await Array.fromAsync(new Bun.Glob("**/SKILL.md").scan({ cwd: target, dot: true }))
  return `Installed ${found.length} skill(s) to ${target}. They load in the next session; read a SKILL.md directly to use one now:\n${found
    .slice(0, 20)
    .map((file) => path.join(target, file))
    .join("\n")}`
}

export async function uninstall(entry: Entry, scope: Scope, root: string) {
  const where = await paths(scope, root)
  if (entry.kind === "mcp") {
    await edit(where.config, ["mcp", entry.id], undefined)
    return `Removed MCP server ${entry.id} from ${where.config}`
  }
  if (entry.kind === "plugin") {
    const current = plugins(await readConfig(where.config))
    await edit(
      where.config,
      ["plugin"],
      current.filter((spec) => !samePlugin(spec, entry.plugin!)),
    )
    return `Removed plugin ${entry.id} from ${where.config}`
  }
  await fs.rm(path.join(where.skills, entry.id), { recursive: true, force: true })
  await fs.rm(path.join(where.skills, `.${entry.id}`), { recursive: true, force: true })
  return `Removed skill ${entry.id} from ${where.skills}`
}

export async function setEnabled(entry: Entry, scope: Scope, root: string, enabled: boolean) {
  const where = await paths(scope, root)
  if (entry.kind === "mcp") {
    // Works for bundled servers too: the scope file only overrides `enabled`.
    await edit(where.config, ["mcp", entry.id, "enabled"], enabled)
    return `${enabled ? "Enabled" : "Disabled"} MCP server ${entry.id} in ${where.config}`
  }
  if (entry.kind === "plugin") {
    // ponytail: plugin lists accumulate across config layers, so a bundled plugin can't be
    // switched off from user config yet; needs a disabled-plugins setting in the engine.
    if (!enabled && entry.bundled) throw new Error(`${entry.id} is bundled with DeV and can't be disabled yet`)
    return enabled ? install(entry, scope, root) : uninstall(entry, scope, root)
  }
  // The skill scanner skips dot-directories, so a leading dot disables a skill in place.
  const [from, to] = enabled ? [`.${entry.id}`, entry.id] : [entry.id, `.${entry.id}`]
  if (!(await exists(path.join(where.skills, from))))
    throw new Error(`${entry.id} is not ${enabled ? "disabled" : "installed"} in ${scope} scope`)
  await fs.rename(path.join(where.skills, from), path.join(where.skills, to))
  return `${enabled ? "Enabled" : "Disabled"} skill ${entry.id} in ${where.skills}`
}

export async function paths(scope: Scope, root: string) {
  const dir = scope === "user" ? Global.Path.config : path.join(root, ".opencode")
  const names =
    scope === "user" ? ["opencode.jsonc", "opencode.json", "config.json"] : ["opencode.jsonc", "opencode.json"]
  const existing = await Promise.all(
    names.map(async (name) => ((await exists(path.join(dir, name))) ? name : undefined)),
  )
  return {
    config: path.join(dir, existing.find(Boolean) ?? "opencode.json"),
    skills: path.join(dir, "skills"),
  }
}

async function fetchSkill(skill: NonNullable<Entry["skill"]>) {
  const target = path.join(Global.Path.cache, "catalog", `${Bun.hash(skill.repo + "#" + skill.ref).toString(16)}`)
  if (await exists(target)) return target
  const staging = `${target}.tmp-${process.pid}`
  await fs.rm(staging, { recursive: true, force: true })
  await $`git init -q ${staging}`.quiet()
  await $`git -C ${staging} fetch -q --depth 1 ${skill.repo} ${skill.ref}`.quiet()
  await $`git -C ${staging} -c advice.detachedHead=false checkout -q FETCH_HEAD`.quiet()
  await fs.rm(path.join(staging, ".git"), { recursive: true, force: true })
  await fs.rename(staging, target)
  return target
}

async function readConfig(
  file: string,
): Promise<{ mcp?: Record<string, { type?: string; enabled?: boolean }>; plugin?: unknown[] }> {
  const text = await Bun.file(file)
    .text()
    .catch(() => "{}")
  return parse(text) ?? {}
}

async function edit(file: string, at: string[], value: unknown) {
  const text = await Bun.file(file)
    .text()
    .catch(() => '{\n  "$schema": "https://opencode.ai/config.json"\n}\n')
  const next = applyEdits(text, modify(text, at, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, next)
}

function plugins(cfg: { plugin?: unknown[] }) {
  return (cfg.plugin ?? []).flatMap((item) => (typeof item === "string" ? [item] : []))
}

// "name@version", "@scope/name@version" and "name@git+url#ref" are all identified by their name.
function samePlugin(a: string, b: string) {
  return pluginName(a) === pluginName(b)
}

function pluginName(spec: string) {
  if (spec.startsWith("@")) return "@" + spec.slice(1).split("@")[0]
  return spec.split("@")[0]
}

function exists(file: string) {
  return fs.access(file).then(
    () => true,
    () => false,
  )
}

export * as Catalog from "."
