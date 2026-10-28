#!/usr/bin/env bun
// DeV rebrand: rewrites user-visible "OpenCode"/"opencode" text to DeV. Re-run after every
// upstream merge and review the diff. `--check` lists what would change and exits 1 if anything
// would, so CI can keep the branding from drifting.
//
// Internal identifiers stay: import specifiers (@opencode-ai/*), OPENCODE_* env reads, provider and
// integration ids ("opencode"), and file-name literals in code (stock names are still read, see
// packages/core/src/brand.ts). Only text a person reads is rewritten.

import path from "path"

const root = path.resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")

// "OpenCode Zen"/"OpenCode Go" are third-party product names and stay as they are.
const display = (text: string) =>
  text
    .replace(/\bOpenCode\b(?! (Zen|Go)\b)/g, "DeV")
    .replace(/\bOpencode\b/g, "DeV")
    // Every OPENCODE_X setting can be given as DEV_X (see packages/opencode/src/index.ts).
    .replace(/\bOPENCODE_([A-Z0-9_]+)\b/g, "DEV_$1")

// Prose (prompts, docs, translations): file names, folders and the CLI name too.
const prose = (text: string) =>
  display(text)
    .replace(/~\/\.config\/opencode\b/g, "~/.config/dev")
    .replace(/~\/\.local\/share\/opencode\b/g, "~/.local/share/dev")
    .replace(/(?<![\w@-])opencode\.jsonc\b/g, "dev.jsonc")
    .replace(/(?<![\w@-])opencode\.json\b/g, "dev.json")
    .replace(/(?<![\w@-])\.opencode\//g, ".dev/")
    .replace(/https:\/\/github\.com\/(anomalyco|sst)\/opencode/g, "https://github.com/Harsha-code-per/DeV")
    .replace(/https:\/\/opencode\.ai\/docs\/?/g, "https://github.com/Harsha-code-per/DeV#readme")
    // Inside `code` it is the command; in running text it is the product name.
    .replace(/`[^`\n]*`/g, (span) => span.replace(/(?<![\w@./-])opencode(?![\w.-])/g, "dev"))
    .replace(/(?<![\w@./`-])opencode(?![\w.-])/g, "DeV")

// Code: only sentences in user-facing lines (help text, prompts, logs, titles). A quoted segment
// must contain a space, so ids ("opencode"), theme names, CSS classes and identifiers stay.
const USER_FACING = /describe:|description:|message|placeholder|title|label|intro|outro|println|log\.(info|warn|error|success|message)|prompts\.|UI\.(error|println)|throw new Error|safeMessage|footnote|headline/
const code = (text: string) =>
  text
    .split("\n")
    .map((line) =>
      USER_FACING.test(line)
        ? line.replace(/"[^"\n]* [^"\n]*"|'[^'\n]* [^'\n]*'|`[^`\n]* [^`\n]*`/g, (segment) =>
            display(segment).replace(/(?<![\w@./-])opencode(?![\w.-])/g, "dev"),
          )
        : line,
    )
    .join("\n")

const SCOPES = [
  { glob: "packages/{opencode,core,tui,app,desktop,ui,session-ui,plugin,server,cli}/src/**/*.{txt,md}", rewrite: prose },
  { glob: "packages/app/src/i18n/*.ts", rewrite: prose },
  {
    glob: "packages/{opencode,core,tui,app,desktop,ui,session-ui,plugin,server,cli}/src/**/*.{ts,tsx}",
    rewrite: code,
  },
]

const SKIP = [/\.test\.tsx?$/, /\/i18n\//, /\/generated/, /\.gen\.ts$/]

const changed: string[] = []
const seen = new Set<string>()
for (const scope of SCOPES) {
  for await (const rel of new Bun.Glob(scope.glob).scan({ cwd: root })) {
    if (seen.has(rel)) continue
    if (scope.rewrite === code && SKIP.some((re) => re.test(rel))) continue
    seen.add(rel)
    const file = Bun.file(path.join(root, rel))
    const before = await file.text()
    const after = scope.rewrite(before)
    if (after === before) continue
    changed.push(rel)
    if (!check) await Bun.write(file, after)
  }
}

console.log(`${check ? "would change" : "changed"} ${changed.length} file(s)`)
for (const rel of changed) console.log(`  ${rel}`)
if (check && changed.length) process.exit(1)
