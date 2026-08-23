#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
const fail = (message) => { console.error(`ERROR: ${message}`); process.exit(2); };
if (args.includes("--help") || args.includes("-h")) {
  console.log("用法：node prepare-redskill.mjs --source <本地文件夹|ZIP|链接> --output <输出目录> [--skill <相对路径>] [--display-name <展示名称>] [--skill-id <英文 ID>] [--short-intro <一句话简介>] [--version <版本>]\n\n创建独立 REDSkill 候选副本和提交资料草案，绝不修改源文件；仅在没有阻断项时生成上传 ZIP。");
  process.exit(0);
}

const sourceArg = value("--source");
const outputArg = value("--output");
if (!sourceArg || !outputArg) fail("必须提供 --source 和 --output。");
const outputDir = resolve(outputArg);
if (existsSync(outputDir)) fail(`输出目录已存在：${outputDir}。请使用新的目录。`);

const workDir = mkdtempSync(join(tmpdir(), "punk-redskill-forge-"));
const sourceRoot = join(workDir, "source");
const blockers = [];
const warnings = [];
const notes = [];
const ignoredNames = new Set([".git", "node_modules", ".DS_Store", "__MACOSX", ".pytest_cache", ".next", "dist", "build", "coverage"]);
const ignoredExtensions = new Set([".pyc", ".pyo", ".class", ".o", ".so", ".dylib"]);
const textExtensions = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash", ".zsh", ".toml", ".ini", ".cfg", ".xml", ".html", ".css", ".csv"]);

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}
function materializeSource() {
  if (/^https:\/\/(www\.)?github\.com\//.test(sourceArg) || /^git@github\.com:/.test(sourceArg)) {
    run("git", ["clone", "--depth", "1", sourceArg, sourceRoot]);
    return;
  }
  const path = resolve(sourceArg);
  if (!existsSync(path)) fail(`源文件不存在：${path}`);
  if (statSync(path).isDirectory()) { cpSync(path, sourceRoot, { recursive: true, dereference: false }); return; }
  if (extname(path).toLowerCase() === ".zip") { mkdirSync(sourceRoot); run("unzip", ["-q", path, "-d", sourceRoot]); return; }
  fail("源文件必须是本地文件夹、ZIP 压缩包或 GitHub 链接。");
}
function walk(root, callback) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) walk(absolute, callback);
    else if (entry.isFile()) callback(absolute);
  }
}
function findSkillFiles(root) {
  const found = [];
  walk(root, (file) => { if (basename(file) === "SKILL.md") found.push(file); });
  return found;
}
function selectSkill() {
  const wanted = value("--skill");
  const skillFiles = findSkillFiles(sourceRoot);
  if (wanted) {
    const candidate = resolve(sourceRoot, wanted);
    const target = basename(candidate) === "SKILL.md" ? candidate : join(candidate, "SKILL.md");
    if (!target.startsWith(sourceRoot + sep) || !existsSync(target)) fail(`找不到指定的 Skill：${wanted}`);
    return target;
  }
  if (skillFiles.length === 1) return skillFiles[0];
  if (skillFiles.length === 0) fail("源文件中没有找到 SKILL.md。");
  fail(`发现多个 Skill；请用 --skill 指定其中一个：\n${skillFiles.map((f) => `  - ${relative(sourceRoot, dirname(f))}`).join("\n")}`);
}
function copyCandidate(skillFile) {
  const skillDir = dirname(skillFile);
  mkdirSync(outputDir, { recursive: true });
  for (const entry of readdirSync(skillDir)) if (!ignoredNames.has(entry)) cpSync(join(skillDir, entry), join(outputDir, entry), { recursive: true, dereference: false });
  let ancestor = skillDir;
  while (ancestor.startsWith(sourceRoot)) {
    const licence = readdirSync(ancestor).find((entry) => /^(licen[cs]e|copying)(\.[a-z0-9-]+)?$/i.test(entry));
    if (licence) {
      const destination = join(outputDir, licence);
      if (!existsSync(destination)) {
        cpSync(join(ancestor, licence), destination, { recursive: false, dereference: false });
        notes.push(`已从源文件树复制 ${licence}，便于许可证追溯。`);
      }
      break;
    }
    if (ancestor === sourceRoot) break;
    ancestor = dirname(ancestor);
  }
  const skillCopy = join(outputDir, "SKILL.md");
  const content = readFileSync(skillCopy, "utf8");
  const styleRef = resolve(skillDir, "../../styles");
  if (content.includes("../../styles/") && existsSync(styleRef) && statSync(styleRef).isDirectory()) {
    cpSync(styleRef, join(outputDir, "styles"), { recursive: true, dereference: false });
    writeFileSync(skillCopy, content.replaceAll("../../styles/", "styles/"));
    notes.push("已复制仓库级 styles 资源，并将 ../../styles/ 引用改为从 ZIP 根目录解析。");
  }
}
function addFinding(kind, file, line, excerpt) {
  const entry = { kind, target: `${relative(outputDir, file)}:${line}`, excerpt };
  (kind.startsWith("BLOCKER") ? blockers : warnings).push(entry);
}
function scanFile(file) {
  const ext = extname(file).toLowerCase();
  const rel = relative(outputDir, file);
  if (ignoredExtensions.has(ext)) { warnings.push({ kind: "WARN_BINARY_OR_EXECUTABLE", target: rel, excerpt: "保留了编译产物或缓存文件；请确认它是否必需。" }); return; }
  if (!textExtensions.has(ext)) { warnings.push({ kind: "WARN_BINARY_OR_EXECUTABLE", target: rel, excerpt: "保留了非文本文件；请检查安全性、用途、授权与披露。" }); return; }
  const content = readFileSync(file, "utf8");
  const checks = [
    ["BLOCKER_SECRET_PATTERN", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\s]{12,}/i],
    ["BLOCKER_XHS_AUTOMATION_PATTERN", /(?:xhs\s+(?:post|comment|reply|like|follow)|xiaohongshu.{0,45}(?:auto(?:matically)?\s*(?:post|publish|comment|reply|like|follow)|自动(?:发布|评论|回复|点赞|关注))|自动(?:发布笔记|回复评论|点赞|关注))/i],
    ["BLOCKER_HIDDEN_BEHAVIOR_PATTERN", /(?:ignore (?:all |any |the )?(?:previous|prior) instructions|hidden (?:behavior|action|function)|secretly (?:collect|send|upload|execute)|绕过(?:用户|安全|限制))/i],
  ];
  for (const [kind, pattern] of checks) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) addFinding(kind, file, content.slice(0, match.index).split("\n").length, match[0].slice(0, 180));
  }
  if (/(?:anthropic|openai|google|apple|microsoft|xiaohongshu)\s+(?:style|风格|logo|商标)/i.test(content)) {
    const match = content.match(/(?:anthropic|openai|google|apple|microsoft|xiaohongshu).{0,80}/i);
    warnings.push({ kind: "WARN_THIRD_PARTY_BRANDING", target: rel, excerpt: (match?.[0] || "第三方品牌内容").slice(0, 180) });
  }
  for (const match of content.matchAll(/(?:\.\.\/)+[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) {
    const potential = resolve(dirname(file), match[0]);
    if (!potential.startsWith(outputDir + sep) || !existsSync(potential)) warnings.push({ kind: "WARN_EXTERNAL_REFERENCE", target: rel, excerpt: `可能无法解析的相对引用：${match[0]}` });
  }
}
function scanCandidate() { walk(outputDir, scanFile); }
function skillMetadata() {
  const text = readFileSync(join(outputDir, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    blockers.push({ kind: "BLOCKER_SKILL_FRONTMATTER", target: "SKILL.md:1", excerpt: "缺少 YAML frontmatter；请提供 name 与 description。" });
    return { name: "", description: "[请人工补充准确的用户可见功能说明]" };
  }
  const name = frontmatter[1].match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1] || "";
  const description = frontmatter[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1] || "";
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) blockers.push({ kind: "BLOCKER_SKILL_NAME", target: "SKILL.md:frontmatter", excerpt: "name 必须是小写字母、数字和连字符组成的稳定 Skill 标识。" });
  if (!description) blockers.push({ kind: "BLOCKER_SKILL_DESCRIPTION", target: "SKILL.md:frontmatter", excerpt: "description 不能为空；请清楚说明用户可见能力。" });
  return { name, description: description || "[请人工补充准确的用户可见功能说明]" };
}
function slugify(input) { return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "redskill"; }
function compact(value) { return value.replace(/\s+/g, " ").trim(); }
function json(value) { return JSON.stringify(value, null, 2) + "\n"; }
function writeDocs(skillFile) {
  const inferred = basename(dirname(skillFile));
  const metadata = skillMetadata();
  const title = value("--display-name") || value("--title") || inferred.replace(/[-_]+/g, " ");
  const version = value("--version") || "0.1.0";
  const capability = compact(metadata.description);
  const skillId = value("--skill-id") || slugify(metadata.name || inferred);
  const shortIntro = compact(value("--short-intro") || capability);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)) blockers.push({ kind: "BLOCKER_SUBMISSION_SKILL_ID", target: "提交资料", excerpt: "Skill ID 建议使用小写字母、数字和连字符；当前值需要人工调整。" });
  const report = (items) => items.length ? items.map((item) => `- **${item.kind}** — \`${item.target}\`: ${item.excerpt}`).join("\n") : "- 机械扫描未发现问题。";
  writeFileSync(join(outputDir, "REDSKILL-AUDIT.md"), `# REDSkill 上传前审计\n\n- 来源：\`${sourceArg}\`\n- 选定的源 Skill：\`${relative(sourceRoot, skillFile)}\`\n- 候选版本：\`${version}\`\n- 状态：**${blockers.length ? "已阻断：解决全部阻断项后方可上传" : "未发现机械扫描阻断项：仍须人工复核"}**\n\n## 阻断项\n\n${report(blockers)}\n\n## 警告项\n\n${report(warnings)}\n\n## 打包说明\n\n${notes.length ? notes.map((note) => `- ${note}`).join("\n") : "- 候选副本由选定 Skill 文件夹复制而来，原始 Skill 未被修改。"}\n\n## 必须人工复核\n\n- 确认包内实际代码和提示词，与声明的功能、权限、数据使用及输出一致。\n- 确认全部依赖、第三方内容、名称和素材拥有适当许可证或授权。\n- 确认不存在小红书账号自动化、凭证处理、隐藏行为或未声明的网络/本地数据访问。\n- 提交前查看小红书最新 REDSkill 官方规范与上传页。\n`);
  const submission = {
    display_name: title,
    skill_id: skillId,
    version,
    short_intro: shortIntro,
    detailed_intro: `这个 Skill 的用途是：${capability}\n\n用户提供必要的输入后，Skill 按文档中声明的范围执行，并给出对应结果。请在提交前补充具体输入、输出和适用场景，且只保留源 Skill 已实现的内容。`,
    applicable_scenarios: ["[请填写：用户在什么场景下需要它]"],
    user_inputs: ["[请按 SKILL.md 填写：用户需要提供什么]"],
    expected_outputs: ["[请按 SKILL.md 填写：用户会得到什么]"],
    usage_steps: ["安装或添加该 Skill", "在对话中说明任务并提供必要材料", "确认输出是否符合实际需求"],
    permission_and_data_statement: "仅处理用户在当前任务中主动提供的内容，以及实现声明功能所必需的文件或服务。不请求、不收集、不存储账号凭证、Cookie、API Key、浏览器数据或无关本地数据。",
    external_dependencies: ["[请填写：无；或列出实际依赖的工具、网络服务及用途]"],
    safety_boundary: "不自动操作小红书账号，不发布笔记、不评论、不回复、不点赞、不关注；不含隐藏行为，不诱导 Agent 超出用户明确授权范围。",
    rights_and_attribution: "[请填写：源代码、第三方依赖、商标、图片及其他素材的许可证/署名情况]",
    review_note: "候选包由原始 Skill 的独立副本整理而来。请结合 REDSKILL-AUDIT.md 核对实际能力、权限、数据使用与文档描述一致。",
    source: sourceArg,
    audit_file: "REDSKILL-AUDIT.md",
    operator_checklist: ["删除所有方括号中的待补充内容", "按实时上传页逐项核对字段名称与长度限制", "确保名称、简介、封面、介绍和 ZIP 中实际能力一致", "审核结果以小红书最终审核为准"]
  };
  writeFileSync(join(outputDir, "REDSKILL-SUBMISSION-FIELDS.md"), `# REDSkill 提交资料建议\n\n这是一份给小红书上传页面使用的逐项草案。内容只可描述此包中实际实现的能力；带 \`[请填写]\` 的项目需要作者补齐。页面字段、长度限制和可选项会变化，以实时页面为准。\n\n## 基础信息\n\n| 提交项 | 建议内容 | 提交前检查 |\n| --- | --- | --- |\n| 展示名称 | ${title} | 使用用户能看懂的中文或品牌名；以页面长度限制为准。 |\n| Skill ID | \`${skillId}\` | 建议保持小写英文、数字和连字符；发布后稳定不改。 |\n| 版本 | \`${version}\` | 与本次 ZIP 内容对应。 |\n| 一句话简介 | ${shortIntro} | 不夸大，不承诺审核或结果。 |\n\n## 详细介绍\n\n${submission.detailed_intro}\n\n## 适用场景\n\n${submission.applicable_scenarios.map((item) => `- ${item}`).join("\n")}\n\n## 用户输入\n\n${submission.user_inputs.map((item) => `- ${item}`).join("\n")}\n\n## 预期输出\n\n${submission.expected_outputs.map((item) => `- ${item}`).join("\n")}\n\n## 使用步骤\n\n${submission.usage_steps.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n## 权限与数据说明\n\n${submission.permission_and_data_statement}\n\n## 外部依赖\n\n${submission.external_dependencies.map((item) => `- ${item}`).join("\n")}\n\n## 安全边界\n\n${submission.safety_boundary}\n\n## 权利与署名\n\n${submission.rights_and_attribution}\n\n## 审核备注\n\n${submission.review_note}\n\n## 提交前勾选\n\n${submission.operator_checklist.map((item) => `- [ ] ${item}`).join("\n")}\n`);
  writeFileSync(join(outputDir, "redskill-submission-draft.json"), json(submission));
  writeFileSync(join(outputDir, "README-REDSKILL.md"), `# ${title}\n\n这是根据 \`${sourceArg}\` 单独整理的 REDSkill 候选副本，用于透明检查和 REDSkill 提交前审阅。\n\n## 声明功能\n\n${capability}\n\n## 边界\n\n本包不得自动操作小红书账号、收集凭证/Cookie/API Key、访问无关本地数据或执行隐藏行为。提交前请阅读 \`REDSKILL-AUDIT.md\`。\n`);
  return skillId;
}

try {
  materializeSource();
  const skillFile = selectSkill();
  copyCandidate(skillFile);
  scanCandidate();
  const slug = writeDocs(skillFile);
  if (blockers.length) {
    console.error(`预检已阻断。审计报告：${join(outputDir, "REDSKILL-AUDIT.md")}`);
    process.exitCode = 1;
  } else {
    const zipPath = resolve(dirname(outputDir), `${slug}-redskill.zip`);
    if (existsSync(zipPath)) fail(`ZIP 已存在：${zipPath}。请使用其他输出目录，或由用户明确决定如何处理旧文件。`);
    run("zip", ["-qr", zipPath, "."], outputDir);
    console.log(`候选副本已创建：${outputDir}\n上传压缩包已创建：${zipPath}\n提交前请阅读：${join(outputDir, "REDSKILL-AUDIT.md")}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
