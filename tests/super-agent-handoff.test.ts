// Handoff guard: the macOS target must be able to boot without surprises.
// These are static consistency checks (no macOS needed), so a future edit cannot
// silently reintroduce the wrong port, a conflicting LaunchAgent or a broken bootstrap.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { RulesError, parseRules } from "../protocol/rules.ts";
import { parseListen } from "../host/config.ts";
import { parseSuperConfig } from "../host/super-config.ts";

const ROOT = join(import.meta.dirname, "..");
const STAGING = join(ROOT, "super-agent");
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");
const NOW = 1_700_000_000_000;

test("the hub port is 3350 everywhere, matching the upstream init default", () => {
  assert.equal(read("super-agent/web/app.js").includes("http://127.0.0.1:3350"), true);
  assert.equal(read("super-agent/web/index.html").includes("http://127.0.0.1:3350"), true);
  assert.equal(read("super-agent/web/README.md").includes("http://127.0.0.1:3350"), true);
  assert.equal(read("super-agent/docs/M2_READONLY_PLANE.md").includes("127.0.0.1:3350"), true);
  const config = JSON.parse(read("super-agent/config/super.example.json"));
  assert.deepEqual(parseListen(config.hub.listen), { host: "127.0.0.1", port: 3350 });
  assert.equal(config.hub.publicUrl, "http://127.0.0.1:3350");
  // No stale 8787 in the delivery tree.
  for (const file of [
    "super-agent/web/app.js",
    "super-agent/web/index.html",
    "super-agent/web/README.md",
    "super-agent/docs/M2_READONLY_PLANE.md",
    "super-agent/config/super.example.json",
    "super-agent/scripts/dev-wsl.sh",
    "super-agent/scripts/bootstrap-macos.sh",
  ]) {
    assert.ok(!read(file).includes("8787"), `${file} still has the wrong port`);
  }
});

test("both example configs are valid for their own parsers", () => {
  const rules = read("super-agent/config/rules.example.json");
  assert.ok(!Object.hasOwn(JSON.parse(rules) as object, "super"), "super must not be in rules.json");
  try {
    assert.equal(parseRules(rules, NOW, "Asia/Shanghai").rules.length, 3);
  } catch (error) {
    assert.fail(
      `rules.example.json must boot the hub: ${error instanceof RulesError ? error.issues.join(" | ") : error}`,
    );
  }
  const superCfg = parseSuperConfig(JSON.parse(read("super-agent/config/super.example.json")));
  assert.equal(superCfg.projects.length, 3);
  assert.equal(superCfg.schedule.length, 3);
  assert.equal(superCfg.bindings.channels["home-deco"], "feishu");
  assert.equal(read(".nvmrc").trim(), "24");
});

test("the LaunchAgent template is valid XML, warns about the upstream service, and has no raw paths", () => {
  const text = read("super-agent/deploy/com.superagent.runtime.plist");
  assert.match(text, /<\?xml version="1\.0"/);
  assert.match(text, /<\/plist>\s*$/);
  // XML comments cannot contain a double hyphen; that broke an earlier version.
  // The delimiters themselves contain "--"; only the comment body is restricted.
  const comment = text.slice(text.indexOf("<!--") + 4, text.indexOf("-->"));
  assert.ok(!comment.includes("--"), "a double hyphen inside the XML comment makes the plist unparseable");
  assert.match(comment, /agent-autoloop\.plist/);
  assert.match(comment, /no-service/);
  for (const placeholder of ["__NODE_BIN__", "__REPO_ROOT__", "__HOME_DIR__"]) {
    assert.ok(text.includes(placeholder), placeholder);
  }
  assert.ok(!text.includes("/Users/me"), "no hard-coded home directory");
  assert.ok(text.includes("<key>PATH</key>"));
  assert.ok(read("super-agent/deploy/superagent-runtime.service").includes("agent-autoloop init"));
});

test("both bootstrap scripts are syntactically valid bash", () => {
  for (const script of ["super-agent/scripts/dev-wsl.sh", "super-agent/scripts/bootstrap-macos.sh"]) {
    const result = spawnSync("bash", ["-n", join(ROOT, script)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("the full suite is optional in both bootstraps (it needs a logged-in Agent CLI)", () => {
  for (const script of ["super-agent/scripts/dev-wsl.sh", "super-agent/scripts/bootstrap-macos.sh"]) {
    const text = read(script);
    assert.match(text, /SUPER_FULL_TEST/, script);
    assert.ok(!/^npm test$/m.test(text), `${script} must not run npm test unconditionally`);
  }
});

test("every test file referenced by the bootstraps actually exists", () => {
  for (const script of ["super-agent/scripts/dev-wsl.sh", "super-agent/scripts/bootstrap-macos.sh"]) {
    const referenced = [...new Set([...read(script).matchAll(/tests\/[A-Za-z0-9._-]+\.test\.ts/g)].map((m) => m[0]))];
    assert.ok(referenced.length >= 10, `${script} references too few tests`);
    for (const file of referenced) assert.ok(existsSync(join(ROOT, file)), `${script} references missing ${file}`);
    assert.ok(referenced.includes("tests/super-agent-handoff.test.ts"));
  }
});

test("the macOS bootstrap uses node@24 and defers service installation to the upstream init", () => {
  const text = read("super-agent/scripts/bootstrap-macos.sh");
  assert.match(text, /brew --prefix node@24/);
  assert.match(text, /init --port/);
  assert.match(text, /render-plist/);
  assert.match(text, /Do NOT install a second LaunchAgent/);
  assert.match(text, /npm run test:sim/);
  assert.match(text, /uname -s/);
});

test("the handoff document exists and carries the verification checklist", () => {
  const text = read("super-agent/docs/HANDOFF_MACOS.md");
  for (const section of [
    "## 1. 移交时的状态",
    "## 2. 两个最容易踩的坑",
    "## 3. 在 Mac 上从零开始",
    "## 4. 验证清单",
    "## 6. 唯一剩余任务",
    "## 7. 红线",
  ]) {
    assert.ok(text.includes(section), section);
  }
  assert.match(text, /3350/);
  assert.match(text, /init --port 3350/);
});

test("the formal handover contract exists and complements the operations manual", () => {
  const contract = read("super-agent/docs/MAC_MIGRATION_HANDOFF.md");
  for (const section of [
    "## 文档控制",
    "## 1. 交接摘要",
    "## 3. 交付物清单",
    "## 4. 环境差异矩阵",
    "## 7. 验收标准",
    "## 8. 剩余工作",
    "## 9. 风险登记与缓解",
    "## 10. 回滚与应急",
    "## 12. 回传与签收",
    "## 附录 B",
  ]) {
    assert.ok(contract.includes(section), section);
  }
  assert.match(contract, /190\/190/, "acceptance criteria must cite the green subset size");
  assert.match(contract, /3350/, "the contract must state the upstream default port");
  assert.match(contract, /d5c4e9a/, "the handoff must pin the HEAD it was written against");
  assert.match(contract, /HANDOFF_MACOS\.md/, "the manual and the contract must cross-reference");
  assert.ok(read("super-agent/docs/HANDOFF_MACOS.md").includes("MAC_MIGRATION_HANDOFF.md"));
});

test("the upstream HTTP handler is still within its architecture line limit", () => {
  assert.ok(read("host/http.ts").split("\n").length <= 50);
  assert.ok(existsSync(join(STAGING, "deploy", "com.superagent.runtime.plist")));
});
