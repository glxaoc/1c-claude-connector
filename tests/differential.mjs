// Сравнительная проверка (differential): одинаковые вызовы инструментов идут в два сервера коннектора,
// этот репозиторий и соседний (1c-connector для Claude и 1c-chatgpt-connector для ChatGPT/Codex),
// оба ходят в одну и ту же подложную 1С (tests/mock1c2.mjs) и SSH-заглушку (tests/mockssh2.mjs).
// Ответы, инструкции, список инструментов и запросы, дошедшие до 1С, должны совпасть. Несущественное (порты, временная папка)
// нормализуется, а намеренные расхождения редакций перечислены ниже в APPROVED.
//
//   node tests/differential.mjs
//   DIFF_OTHER_REPO=C:/путь/к/другому/репо node tests/differential.mjs
//
// Другой репозиторий ищется в DIFF_OTHER_REPO, затем рядом с этим (../1c-chatgpt-connector или ../1c-connector).
// Если его нет, проверка честно пишет «СРАВНЕНИЕ: пропущено» и выходит с кодом 0 (verify считает это провалом,
// если не задано DIFF_ALLOW_SKIP=1); если DIFF_OTHER_REPO задан,
// но там нет сервера или node_modules, это ошибка (код 1). Можно сравнить и две версии одной редакции.
// Файл одинаковый в обоих репозиториях.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.resolve(dir, "..");
const edition = (repo) => (fs.readFileSync(path.join(repo, "server", "index.js"), "utf8").match(/const EDITION = "(\w+)"/) || [])[1];
const version = (repo) => (fs.readFileSync(path.join(repo, "server", "index.js"), "utf8").match(/const VERSION = "([^"]+)"/) || [])[1];
const usable = (repo) => fs.existsSync(path.join(repo, "server", "index.js")) && fs.existsSync(path.join(repo, "node_modules", "@modelcontextprotocol", "sdk"));

const hereEd = edition(HERE);
let other = process.env.DIFF_OTHER_REPO ? path.resolve(process.env.DIFF_OTHER_REPO) : null;
if (other && !usable(other)) { console.log(`❌ DIFF_OTHER_REPO=${other}: нет server/index.js или node_modules (npm ci)`); process.exit(1); }
if (!other) other = [path.resolve(HERE, "..", hereEd === "claude" ? "1c-chatgpt-connector" : "1c-connector")].find(usable) || null;
if (!other) { console.log("СРАВНЕНИЕ: пропущено, соседний репозиторий не найден (задайте DIFF_OTHER_REPO)"); process.exit(0); }
// какой именно код сравнивается: ветка, коммит и есть ли незакоммиченные правки
const gitInfo = (repo) => { try {
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return `${g("branch", "--show-current") || "detached"} ${g("rev-parse", "--short", "HEAD")}${g("status", "--porcelain", "--", "server") ? ", server/ изменён" : ""}`;
} catch { return "не git"; } };
const SIDES = [
  { repo: HERE, ed: hereEd, ver: version(HERE), git: gitInfo(HERE) },
  { repo: other, ed: edition(other), ver: version(other), git: gitInfo(other) },
];
console.log(`Сравнение: ${SIDES.map((s) => `${s.ed} ${s.ver} [${s.git}] (${s.repo})`).join("  и  ")}`);

// ---------- одобренные расхождения ----------
// Формат: id, почему так задумано, что заменить в тексте каждой редакции и на что (одинаковая метка с двух сторон).
// После замены тексты должны совпасть. Правило, которое ни разу не понадобилось, выводится в конце: возможно, оно устарело.
const INSTALLER = /(?:INSTALL\.bat|install-mac\.sh)/.source;
const APPROVED = [
  { id: "версия", why: "редакции выпускаются отдельно, у каждой своя версия",
    claude: (s) => new RegExp(esc(s.ver), "g"), chatgpt: (s) => new RegExp(esc(s.ver), "g"), as: "<ВЕРСИЯ>" },
  { id: "название приложения", why: "коннектор называет приложение, в котором работает",
    claude: /\bClaude\b/g, chatgpt: /\bChatGPT\b/g, as: "<ПРИЛОЖЕНИЕ>" },
  { id: "метка редакции в ссылке автору", why: "автор видит, из какой редакции пришло сообщение",
    claude: /\(claude\)/g, chatgpt: /\(chatgpt\)/g, as: "(<РЕДАКЦИЯ>)" },
  { id: "канал автора", why: "своя именная ссылка на канал для каждой редакции, чтобы видеть источник подписчиков",
    claude: /\+nOX4y5DWNl42NWIy/g, chatgpt: /\+5eLLn8GuPQZhYWM6/g, as: "<КАНАЛ>" },
  // Где пользователь вводит настройки: в Claude Desktop форма расширения, в Codex установщик.
  { id: "настройки: нет адреса", why: "в Codex настройки вводят установщиком",
    claude: /Откройте настройки расширения и впишите/g, chatgpt: new RegExp(`Запустите ${INSTALLER} и впишите`, "g"), as: "<ГДЕ НАСТРОЙКИ> впишите" },
  { id: "настройки: 401", why: "в Codex настройки вводят установщиком",
    claude: /Проверьте «Логин» и «Пароль» 1С в настройках расширения\./g, chatgpt: new RegExp(`Запустите ${INSTALLER} снова и проверьте логин и пароль 1С\\.`, "g"), as: "<ГДЕ ПРОВЕРИТЬ ЛОГИН 1С>" },
  { id: "настройки: SSH не принял логин", why: "в Codex настройки вводят установщиком",
    claude: /Проверьте «Логин сервера» и «Пароль сервера» в настройках расширения\./g, chatgpt: new RegExp(`Запустите ${INSTALLER} снова и проверьте логин и пароль сервера\\.`, "g"), as: "<ГДЕ ПРОВЕРИТЬ ЛОГИН SSH>" },
  { id: "настройки: нет логина SSH", why: "в Codex настройки вводят установщиком",
    claude: /Заполните его в настройках расширения\./g, chatgpt: new RegExp(`Запустите ${INSTALLER} снова и укажите логин\\.`, "g"), as: "<ГДЕ УКАЗАТЬ ЛОГИН SSH>" },
  { id: "настройки: нет пароля и ключа SSH", why: "в Codex настройки вводят установщиком",
    claude: /Заполните «Пароль сервера» или выберите файл ключа\./g, chatgpt: new RegExp(`Запустите ${INSTALLER} снова и укажите пароль сервера или файл ключа\\.`, "g"), as: "<ГДЕ УКАЗАТЬ ПАРОЛЬ SSH>" },
  { id: "настройки: пароли не в чате", why: "в Codex пароли вводят в установщике",
    claude: /их вводят только в настройках расширения\./g, chatgpt: new RegExp(`их вводят только при установке \\(${INSTALLER}\\)\\.`, "g"), as: "их вводят только <ГДЕ ПАРОЛИ>." },
  { id: "настройки: совет описать базу", why: "в Codex описание базы вводят в установщике",
    claude: /в настройках расширения можно описать базу/g, chatgpt: new RegExp(`при установке \\(${INSTALLER}\\) можно описать базу`, "g"), as: "<ГДЕ ОПИСАНИЕ> можно описать базу" },
  { id: "тильда в пути SSH-ключа", why: "в Codex путь к ключу пишут руками в установщике, поэтому ~ раскрывается в домашнюю папку; в Claude путь выбирают в форме и он всегда полный",
    claude: /\(~\/нет-ключа\)/g, chatgpt: /\(<HOME>\/нет-ключа\)/g, as: "(<КЛЮЧ ИЗ ДОМАШНЕЙ ПАПКИ>)" },
];
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const used = new Set();

// ---------- заглушки ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c1diff-"));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(String(port))); });
});
// У каждой стороны своя заглушка 1С (одинаковая), чтобы записать, какие запросы дошли до 1С от каждой редакции.
// Порт «dead» берём свободным и закрываем: там никто не слушает (если его займёт другой процесс, сценарии
// «закрытый порт» могут разойтись, это будет видно в выводе).
const P = { odata0: await freePort(), odata1: await freePort(), ssh: await freePort(), sshKey: await freePort(), dead: await freePort() };
const REQLOGS = [path.join(tmp, "reqs0.log"), path.join(tmp, "reqs1.log")];
const procs = [];
const start = (file, env, label) => new Promise((res, rej) => {
  const p = spawn(process.execPath, [path.join(dir, file)], { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  procs.push(p);
  let err = "";
  const t = setTimeout(() => rej(new Error(`${label} не запустилась за 10 с: ${err.slice(0, 300)}`)), 10_000);
  p.stderr.on("data", (d) => { err += d; if (/ up/.test(err)) { clearTimeout(t); res(); } });
  p.on("exit", (code) => { clearTimeout(t); rej(new Error(`${label} завершилась с кодом ${code}: ${err.slice(0, 300)}`)); });
});
const stopAll = () => { for (const p of procs) { p.removeAllListeners("exit"); p.kill(); } fs.rmSync(tmp, { recursive: true, force: true }); };
try {
  await Promise.all([
    start("mock1c2.mjs", { PORT: P.odata0, REQLOG: REQLOGS[0] }, "заглушка 1С"),
    start("mock1c2.mjs", { PORT: P.odata1, REQLOG: REQLOGS[1] }, "заглушка 1С (вторая)"),
    start("mockssh2.mjs", { KEYFILE: path.join(tmp, "hostkey1"), PORT: P.ssh }, "SSH-заглушка"),
    start("mockssh2.mjs", { KEYFILE: path.join(tmp, "hostkey2"), PORT: P.sshKey, MODE: "keyonly" }, "SSH-заглушка (только ключ)"),
  ]);
} catch (e) { console.log("❌ " + e.message); stopAll(); process.exit(1); }

// ---------- сценарии ----------
// @ODATA@ в настройках и аргументах заменяется на порт заглушки 1С своей стороны
const U = (p) => `http://127.0.0.1:@ODATA@${p}`;
const GOOD = { ODATA_URL: U("/УТ11/odata/standard.odata/"), ODATA_USERNAME: "odata.user", ODATA_PASSWORD: "p@ss word",
  DB_DESCRIPTION: "${user_config.db_description}", ALLOW_SELF_SIGNED: "${user_config.allow_self_signed}",
  SSH_HOST: "${user_config.ssh_host}", SSH_USER: "${user_config.ssh_user}", SSH_PASSWORD: "${user_config.ssh_password}", SSH_KEY_PATH: "${user_config.ssh_key}" };
const SSHOK = { SSH_HOST: `127.0.0.1:${P.ssh}`, SSH_USER: "deploy", SSH_PASSWORD: "srv pass" };
const TWO = { BASE_NAME: "Бухгалтерия", BASE_NAME_2: "ERP", ODATA_URL_2: U("/ERP/odata/standard.odata/"), ODATA_USERNAME_2: "erp.user", ODATA_PASSWORD_2: "erp pass" };
const CC = ["check_connection", {}];
const SCENARIOS = [
  { name: "главный путь: данные", env: { DB_DESCRIPTION: "УТ 11, стройматериалы" }, calls: [
    ["@tools"], ["@instructions"], CC,
    ["list_objects", {}], ["list_objects", { contains: "реализация, номенклатура" }], ["list_objects", { contains: "несуществующее" }],
    ["describe_object", { object: "Document_РеализацияТоваровУслуг" }], ["describe_object", { object: "Document_РеализацияТоваровУслуг_Товары_RowType" }], ["describe_object", { object: "Document_Реализация" }],
    ["query", { object: "Document_РеализацияТоваровУслуг", top: 5 }], ["query", { object: "Document_РеализацияТоваровУслуг", top: 500 }],
    ["query", { object: "Document_РеализацияТоваровУслуг", select: "Number, Контрагент/Description", top: 2 }],
    ["query", { object: "Document_РеализацияТоваровУслуг", select: "Number,Основание/Контрагент/Description", expand: "Склад", top: 2 }],
    // все параметры запроса сразу, со спецсимволами в фильтре: сравнение «@запросы в 1С» видит, что ушло в 1С
    ["query", { object: "Document_РеализацияТоваровУслуг", filter: "Posted eq true and Number eq '00-1''&#%+ №'", orderby: "Date desc, Number", select: "Number, Date", top: 3, skip: 1 }],
    ["count", { object: "Document_РеализацияТоваровУслуг", filter: "Контрагент/Description eq 'ООО «Ромашка» & Ко'" }],
    ["query", { object: "AccumulationRegister_ТоварыНаСкладах/Balance(Period=datetime'2026-09-30T23:59:59')" }],
    ["query", { object: U("/УТ11/odata/standard.odata/AccumulationRegister_ТоварыНаСкладах/Balance()") }],
    ["count", { object: "Document_РеализацияТоваровУслуг" }], ["count", { object: "AccumulationRegister_ТоварыНаСкладах/Balance()" }],
  ] },
  { name: "ошибки данных", calls: [
    ["query", { object: "Document_РеализацияТоваровУслуг", filter: "НетТакого eq 'BAD'" }], ["query", { object: "Catalog_Ошибка500" }], ["query", { object: "Catalog_НетТакого" }],
    ["query", { object: "../../etc/passwd" }], ["query", { object: "Catalog_X?$method=DELETE" }], ["query", { object: "" }], ["count", { object: "Catalog_НетТакого" }],
  ] },
  { name: "порции и пределы бесплатной версии", calls: [
    ["query", { object: "Catalog_Много", select: "Description", top: 1000 }], ["query", { object: "Catalog_Много", top: 5000 }], ["query", { object: "Catalog_Много", top: 1000, skip: 2000 }], ["query", { object: "Catalog_Много", top: 10 }],
  ] },
  { name: "реклама, обращение автору, справка про ПДн", calls: [
    ["what_else", {}], ["contact_author", { task: "Подключить CRM и отчёты в Telegram" }], ["contact_author", { task: "x".repeat(300) }],
    ["query", { object: "Catalog_Контрагенты", select: "Description,Телефон", top: 2 }], ["query", { object: "Catalog_Контрагенты", select: "Description,Телефон", top: 2 }], CC,
  ] },
  { name: "база описана", env: { DB_DESCRIPTION: "УТ 11" }, calls: [CC, ["@instructions"]] },
  { name: "неверный пароль 1С", env: { ODATA_PASSWORD: "wrong" }, calls: [CC, ["count", { object: "Catalog_Номенклатура" }]] },
  { name: "пустой адрес", env: { ODATA_URL: "" }, calls: [CC, ["list_objects", {}], ["@instructions"]] },
  { name: "редирект", env: { ODATA_URL: U("/redir") }, calls: [CC] },
  { name: "502 шлюза", env: { ODATA_URL: U("/gw502") }, calls: [CC] },
  { name: "нет базы", env: { ODATA_URL: U("/НетБазы") }, calls: [CC] },
  { name: "веб-клиент вместо OData", env: { ODATA_URL: U("/УТ11/ru_RU/odata/standard.odata/") }, calls: [CC] },
  { name: "https на http-порту", env: { ODATA_URL: "https://127.0.0.1:@ODATA@/УТ11" }, calls: [CC] },
  { name: "закрытый порт", env: { ODATA_URL: `http://127.0.0.1:${P.dead}/УТ11` }, calls: [CC] },
  { name: "две базы", env: TWO, calls: [
    ["@instructions"], ["@tools"], CC, ["count", { object: "Catalog_Склады_ERP", base: "ERP" }], ["count", { object: "Document_РеализацияТоваровУслуг", base: "бухгалтерия" }],
    ["count", { object: "Catalog_Склады_ERP" }], ["count", { object: "Catalog_Склады_ERP", base: "Зарплата" }], ["count", { object: "Catalog_НетТакого", base: "ERP" }],
    ["contact_author", { task: "Две базы" }],
  ] },
  { name: "две базы, у второй неверный пароль", env: { ...TWO, ODATA_PASSWORD_2: "wrong" }, calls: [CC] },
  { name: "SSH: всё верно", env: SSHOK, calls: [CC, ["count", { object: "Document_РеализацияТоваровУслуг" }], ["contact_author", { task: "Через сервер" }]] },
  { name: "SSH: неверный пароль", env: { ...SSHOK, SSH_PASSWORD: "bad" }, calls: [CC] },
  { name: "SSH: нет логина", env: { ...SSHOK, SSH_USER: "" }, calls: [CC] },
  { name: "SSH: нет пароля и ключа", env: { ...SSHOK, SSH_PASSWORD: "" }, calls: [CC] },
  { name: "SSH: сервер только по ключу", env: { ...SSHOK, SSH_HOST: `127.0.0.1:${P.sshKey}` }, calls: [CC] },
  { name: "SSH: сервер не слушает", env: { ...SSHOK, SSH_HOST: `127.0.0.1:${P.dead}` }, calls: [CC] },
  { name: "SSH: 1С недоступна с сервера", env: { ...SSHOK, ODATA_URL: `http://127.0.0.1:${P.dead}/УТ11` }, calls: [CC] },
  { name: "SSH: ключ из домашней папки не найден", env: { ...SSHOK, SSH_KEY_PATH: "~/нет-ключа" }, calls: [CC] },
];

async function runSide(side, sc, home, i) {
  const c = new Client({ name: "diff", version: "1" });
  const sub = (v) => JSON.parse(JSON.stringify(v).split("@ODATA@").join(P[`odata${i}`]));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...sub({ ...GOOD, ...(sc.env || {}) }) };
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(side.repo, "server", "index.js")], env, stderr: "pipe" }));
  const out = [];
  try {
    for (const [tool, args] of sc.calls) {
      if (tool === "@tools") {
        const { tools } = await c.listTools();
        out.push(JSON.stringify(tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })).sort((a, b) => a.name.localeCompare(b.name)), null, 1));
      } else if (tool === "@instructions") out.push(c.getInstructions?.() || "");
      else {
        const r = await c.callTool({ name: tool, arguments: sub(args) });
        out.push(`${r.isError ? "[ошибка] " : ""}${r.content.map((x) => x.text).join("\n")}`);
      }
    }
  } finally { await c.close(); }
  return out;
}

function normalize(text, side, home) {
  let s = text;
  // несущественное: случайные порты заглушек и временная домашняя папка
  for (const [key, v] of Object.entries(P)) { const k = key.replace(/^odata\d$/, "odata"); s = s.split(`127.0.0.1:${v}`).join(`127.0.0.1:<PORT_${k}>`).split(`127.0.0.1%3A${v}`).join(`127.0.0.1%3A<PORT_${k}>`); }
  for (const h of [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]) s = s.split(h).join("<HOME>");
  for (const r of APPROVED) {
    let re = r[side.ed];
    if (!re) continue;
    if (typeof re === "function") re = re(side);
    const before = s;
    s = s.replace(re, r.as);
    if (s !== before) used.add(`${r.id}|${side.ed}`);
  }
  return s;
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 80);
  return `с символа ${i}:\n      ${SIDES[0].ed}: …${a.slice(from, i + 160).replace(/\n/g, "⏎")}\n      ${SIDES[1].ed}: …${b.slice(from, i + 160).replace(/\n/g, "⏎")}`;
}

let same = 0, diff = 0;
const t0 = Date.now();
try {
  for (const sc of SCENARIOS) {
    const homes = SIDES.map((s, i) => fs.mkdtempSync(path.join(tmp, `home${i}-`)));
    const logFrom = REQLOGS.map((f) => (fs.existsSync(f) ? fs.statSync(f).size : 0));
    const res = await Promise.all(SIDES.map((s, i) => runSide(s, sc, homes[i], i)));
    // запросы, дошедшие до 1С за сценарий: порядок внутри одного вызова может отличаться (параллельные запросы), поэтому сортируем
    const sent = REQLOGS.map((f, i) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(logFrom[i]).toString("utf8") : "").split("\n").filter(Boolean).sort().join("\n"));
    res.forEach((r, i) => r.push(sent[i]));
    [...sc.calls, ["@запросы в 1С"]].forEach(([tool, args], k) => {
      const a = normalize(res[0][k], SIDES[0], homes[0]), b = normalize(res[1][k], SIDES[1], homes[1]);
      const label = `${sc.name}: ${tool}${args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0, 90) : ""}`;
      if (a === b) { same++; console.log(`✔ ${label}`); }
      else { diff++; console.log(`✘ ${label}\n    расхождение ${firstDiff(a, b)}`); }
    });
  }
} finally { stopAll(); }

const unused = APPROVED.flatMap((r) => SIDES.map((s) => s.ed).filter((ed, i, a) => a.indexOf(ed) === i && r[ed] && !used.has(`${r.id}|${ed}`)).map((ed) => `${r.id} (${ed})`));
if (unused.length) console.log(`\nℹ️ Одобренные расхождения, которые в этом прогоне не понадобились (для одинаковых редакций это нормально, иначе возможно устарели): ${unused.join("; ")}`);
console.log(`\nСРАВНЕНИЕ: ${same} совпало, ${diff} расхождений (${SIDES.map((s) => `${s.ed} ${s.ver}`).join(" и ")}, ${Math.round((Date.now() - t0) / 1000)} с)`);
process.exit(diff ? 1 : 0);
