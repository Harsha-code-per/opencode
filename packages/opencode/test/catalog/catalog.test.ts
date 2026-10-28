import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { Catalog } from "@/catalog"

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "dev-catalog-"))

describe("Catalog", () => {
  test("every entry is well formed with a unique id and a pinned source", () => {
    const ids = Catalog.entries().map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of Catalog.entries()) {
      expect(entry[entry.kind]).toBeDefined()
      if (entry.kind === "skill") expect(entry.skill!.ref).not.toMatch(/^(main|master|HEAD|latest)$/)
      if (entry.kind === "mcp" && entry.mcp!.type === "local")
        expect(JSON.stringify(entry.mcp!.command)).not.toContain("@latest")
    }
  })

  test("search ranks by keyword matches", () => {
    expect(Catalog.search("reverse engineering binary")[0].id).toBe("rea")
    expect(Catalog.search("browser").map((entry) => entry.id)).toContain("chrome-devtools")
    expect(Catalog.search("zzzz-no-match")).toEqual([])
  })

  test("mcp install, disable, enable and uninstall edit the project config and keep comments", async () => {
    const root = await tmp()
    const where = await Catalog.paths("project", root)
    await fs.mkdir(path.dirname(where.config), { recursive: true })
    await Bun.write(where.config, '{\n  // keep me\n  "$schema": "https://opencode.ai/config.json"\n}\n')
    const entry = Catalog.get("playwright")!

    expect(await Catalog.status(entry, "project", root)).toBe("available")
    await Catalog.install(entry, "project", root)
    expect(await Catalog.status(entry, "project", root)).toBe("installed")
    await Catalog.setEnabled(entry, "project", root, false)
    expect(await Catalog.status(entry, "project", root)).toBe("disabled")
    await Catalog.setEnabled(entry, "project", root, true)
    expect(await Catalog.status(entry, "project", root)).toBe("installed")
    expect(await Bun.file(where.config).text()).toContain("// keep me")
    await Catalog.uninstall(entry, "project", root)
    expect(await Catalog.status(entry, "project", root)).toBe("available")
  })

  test("bundled mcp can be disabled per scope without a full entry", async () => {
    const root = await tmp()
    const entry = Catalog.get("rea")!
    expect(await Catalog.status(entry, "project", root)).toBe("bundled")
    await Catalog.setEnabled(entry, "project", root, false)
    expect(await Catalog.status(entry, "project", root)).toBe("disabled")
  })

  test("plugins are added once and removed by name, including scoped names", async () => {
    const root = await tmp()
    const entry = { ...Catalog.get("superpowers")!, bundled: false, plugin: "@scope/thing@1.0.0" }
    await Catalog.install(entry, "project", root)
    await Catalog.install({ ...entry, plugin: "@scope/thing@2.0.0" }, "project", root)
    const where = await Catalog.paths("project", root)
    expect((await Bun.file(where.config).json()).plugin).toEqual(["@scope/thing@1.0.0"])
    await Catalog.uninstall(entry, "project", root)
    expect((await Bun.file(where.config).json()).plugin).toEqual([])
  })

  test("bundled plugins refuse to be disabled", async () => {
    const root = await tmp()
    await expect(Catalog.setEnabled(Catalog.get("superpowers")!, "project", root, false)).rejects.toThrow("bundled")
  })

  test("skills install from a pinned ref, disable in place and uninstall", async () => {
    const repo = await tmp()
    await fs.mkdir(path.join(repo, "skills", "hello"), { recursive: true })
    await Bun.write(path.join(repo, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: test\n---\nhi\n")
    await $`git -C ${repo} init -q && git -C ${repo} add -A && git -C ${repo} -c user.name=t -c user.email=t@t commit -qm init && git -C ${repo} tag v1`.quiet()

    const root = await tmp()
    const entry = {
      ...Catalog.get("taste")!,
      id: `test-${path.basename(root)}`,
      skill: { repo, ref: "v1", path: "skills" },
    }
    const result = await Catalog.install(entry, "project", root)
    const where = await Catalog.paths("project", root)
    expect(result).toContain(path.join(where.skills, entry.id, "hello", "SKILL.md"))
    expect(await Catalog.status(entry, "project", root)).toBe("installed")

    await Catalog.setEnabled(entry, "project", root, false)
    expect(await Catalog.status(entry, "project", root)).toBe("disabled")
    expect(await Bun.file(path.join(where.skills, `.${entry.id}`, "hello", "SKILL.md")).exists()).toBe(true)

    await Catalog.uninstall(entry, "project", root)
    expect(await Catalog.status(entry, "project", root)).toBe("available")
  })
})
