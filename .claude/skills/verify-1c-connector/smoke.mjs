// verify-1c-connector: дымовой прогон главного пути коннектора на подложной 1С.
// Запуск: node smoke.mjs <папка-доказательств>   (обычно через verify.sh smoke / all)
//
// Что настоящее: server/index.js целиком (MCP по stdio, как его запускает Claude Desktop),
// HTTP-клиент, разбор ошибок, сборка .mcpb тем же mcpb, что в `npm run pack`.
// Что подменено: 1С. Вместо неё локальная OData-заглушка на 127.0.0.1 со случайным портом,
// она записывает каждый запрос (метод, путь, параметры). Внешних адресов нет.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const T0 = Date.now();
const SKILL = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SKILL, "../../..");
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "verify-1c-")));
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "verify-1c-work-")); // HOME сервера и сборка пакета, удаляется в конце
const results = [];
const transcript = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail: cond ? "" : String(detail).slice(0, 600) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : "\n     " + String(detail).slice(0, 400).replace(/\n/g, " | ")}`);
}

// ---------- синтетические данные (правило: только фейковые) ----------
const USER = "smoke.reader";
const PASSWORD = "Смоук-Пароль-7731"; // не должен появиться ни в журнале, ни в ответах
const AUTH = "Basic " + Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64");
const CLIENT_NAME = "ООО Ромашка-Смоук"; // «данные клиента» из базы
const CLIENT_PHONE = "+7 999 000-11-22";
const FILTER_SECRET = "СекретныйФильтр42"; // значение из фильтра пользователя
const DB = "/УТСмоук/odata/standard.odata";

// ---------- заглушка 1С ----------
const seen = []; // все запросы к заглушке
const META = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx><edmx:DataServices><Schema Namespace="StandardODATA">`
  + `<EntityType Name="Catalog_Номенклатура"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="Description" Type="Edm.String"/><Property Name="Артикул" Type="Edm.String"/><Property Name="DeletionMark" Type="Edm.Boolean"/></EntityType>`
  + `<EntityType Name="Document_РеализацияТоваровУслуг"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="Number" Type="Edm.String"/><Property Name="Date" Type="Edm.DateTime"/><Property Name="Posted" Type="Edm.Boolean"/><Property Name="Контрагент_Key" Type="Edm.Guid"/><Property Name="СуммаДокумента" Type="Edm.Double"/><Property Name="Товары" Type="Collection(StandardODATA.Document_РеализацияТоваровУслуг_Товары_RowType)"/><NavigationProperty Name="Контрагент" Relationship="x" FromRole="a" ToRole="b"/></EntityType>`
  + `<ComplexType Name="Document_РеализацияТоваровУслуг_Товары_RowType"><Property Name="LineNumber" Type="Edm.Int64"/><Property Name="Номенклатура_Key" Type="Edm.Guid"/><Property Name="Количество" Type="Edm.Double"/></ComplexType>`
  + `</Schema></edmx:DataServices></edmx:Edmx>`;
const NAMES = ["Catalog_Номенклатура", "Catalog_Контрагенты", "Catalog_Склады", "Document_РеализацияТоваровУслуг", "Document_ЗаказКлиента", "AccumulationRegister_ТоварыНаСкладах", "InformationRegister_ЦеныНоменклатуры", "Catalog_Ошибка500", "Catalog_Закрыт403", "Catalog_Html"];
const SALES = Array.from({ length: 7 }, (_, i) => ({ Ref_Key: `00000000-0000-0000-0000-00000000000${i}`, Number: `СМ-${i + 1}`, Date: `2026-11-0${i + 1}T10:00:00`, Posted: true, "Контрагент@navigationLinkUrl": `Document_X(guid'${i}')/Контрагент`, СуммаДокумента: 1000 * (i + 1) }));
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json;charset=utf-8" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const err1c = (res, code, text) => json(res, code, { "odata.error": { code: "-1", message: { lang: "ru", value: text } } });

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = decodeURIComponent(u.pathname);
  seen.push({ method: req.method, path: p, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization === AUTH });
  if (req.method !== "GET") return err1c(res, 405, "Заглушка принимает только GET");
  if (p.startsWith("/gw502")) { res.writeHead(502, { "content-type": "text/html" }); return res.end("<html>Bad Gateway</html>"); }
  if (!p.startsWith(DB)) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html>not found</html>"); }
  if (req.headers.authorization !== AUTH) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("unauthorized"); }
  const q = p.slice(DB.length).replace(/^\//, "");
  const f = u.searchParams.get("$filter") || "";
  if (q === "") return json(res, 200, "﻿" + JSON.stringify({ "odata.metadata": "x", value: NAMES.map((n) => ({ name: n, url: n })) }));
  if (q === "$metadata") { res.writeHead(200, { "content-type": "application/xml" }); return res.end(META); }
  if (f.includes("НетТакогоПоля")) return err1c(res, 400, "Неправильное выражение фильтра: поле НетТакогоПоля не найдено");
  if (q === "Catalog_Ошибка500") return err1c(res, 500, "Нет свободной лицензии на сервере 1С");
  if (q === "Catalog_Закрыт403") return err1c(res, 403, "Недостаточно прав для чтения данных");
  if (q === "Catalog_Html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body>Веб-клиент 1С</body></html>"); }
  if (q === "Catalog_Контрагенты") return json(res, 200, { value: [{ Description: CLIENT_NAME, Телефон: CLIENT_PHONE }] });
  if (q === "Catalog_Номенклатура") return json(res, 200, { value: [{ Ref_Key: "n1", Description: "Кирпич М150", Артикул: "К-150" }] });
  if (q === "Document_РеализацияТоваровУслуг/$count") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("﻿42"); }
  if (q === "Document_РеализацияТоваровУслуг") {
    const top = +u.searchParams.get("$top") || 50;
    const exp = u.searchParams.get("$expand");
    return json(res, 200, { "odata.metadata": "x", value: SALES.slice(0, top).map((r) => (exp ? { ...r, Контрагент: { Description: CLIENT_NAME } } : r)) });
  }
  if (q === "AccumulationRegister_ТоварыНаСкладах/Balance()") return json(res, 200, { value: [{ Номенклатура: { Description: "Кирпич М150" }, Склад: { Description: "Основной" }, ВНаличииBalance: 120 }] });
  return err1c(res, 404, `Не найден объект ${q}`);
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const PORT = mock.address().port;
const URL1C = `http://127.0.0.1:${PORT}${DB}/`;
// закрытый порт для ECONNREFUSED: занять и сразу освободить
const DEAD = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---------- клиент MCP ----------
const HOME = path.join(WORK, "home");
fs.mkdirSync(HOME);
const BASE_ENV = {
  ODATA_URL: URL1C, ODATA_USERNAME: USER, ODATA_PASSWORD: PASSWORD,
  // так Claude Desktop передаёт пустые необязательные поля
  DB_DESCRIPTION: "${user_config.db_description}", ALLOW_SELF_SIGNED: "${user_config.allow_self_signed}",
  SSH_HOST: "${user_config.ssh_host}", SSH_USER: "${user_config.ssh_user}", SSH_PASSWORD: "${user_config.ssh_password}", SSH_KEY_PATH: "${user_config.ssh_key}",
};
let stderrAll = "";
async function withServer(entry, env, fn) {
  const t = new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || "", HOME, USERPROFILE: HOME, ...BASE_ENV, ...env }, stderr: "pipe" });
  t.stderr?.on("data", (d) => { stderrAll += d.toString(); });
  const c = new Client({ name: "verify-1c", version: "1" });
  await c.connect(t);
  try { return await fn(c); } finally { await c.close(); }
}
const ENTRY = path.join(REPO, "server", "index.js");
async function call(c, name, args = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  transcript.push(`>>> ${name} ${JSON.stringify(args)}\n<<< ${r.isError ? "[isError] " : ""}${text}\n`);
  return { err: !!r.isError, text };
}
const allTexts = [];
const STACK = /\n\s+at .+[\\/].+\.m?js:\d+/;

// ---------- 1. версии и манифест ----------
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
const src = fs.readFileSync(ENTRY, "utf8");
const VERSION = (src.match(/const VERSION = "([^"]+)"/) || [])[1];
check("версии совпадают: server VERSION, manifest, package.json, package-lock", VERSION && [manifest.version, pkg.version, lock.version, lock.packages?.[""]?.version].every((v) => v === VERSION), `server=${VERSION} manifest=${manifest.version} package=${pkg.version} lock=${lock.version}/${lock.packages?.[""]?.version}`);
check("манифест: точка входа server/index.js", manifest.server?.entry_point === "server/index.js" && manifest.server?.mcp_config?.args?.[0]?.includes("server/index.js"), JSON.stringify(manifest.server?.mcp_config?.args));
const pwFields = Object.entries(manifest.user_config || {}).filter(([k]) => /password/.test(k));
check("манифест: все поля паролей sensitive (хранилище ОС)", pwFields.length >= 4 && pwFields.every(([, v]) => v.sensitive === true), pwFields.map(([k, v]) => `${k}:${v.sensitive}`).join(","));

// ---------- 2. только чтение: код ----------
const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
check("код: все HTTP-запросы методом GET", methods.length > 0 && methods.every((m) => m === "GET"), methods.join(","));
check("код: нет fetch/axios/других HTTP-клиентов в обход httpGet", !/\bfetch\(|axios|undici|\.post\(|\.put\(|\.delete\(/.test(src), "найден посторонний HTTP-вызов");

// ---------- 3. главный путь ----------
await withServer(ENTRY, { DB_DESCRIPTION: "УТ 11, смоук" }, async (c) => {
  const sv = c.getServerVersion();
  check("сервер стартует по stdio, версия как в манифесте", sv?.name === "1c-odata-connector" && sv?.version === VERSION, JSON.stringify(sv));
  const init = c.getInstructions?.() || "";
  check("инструкции: только чтение, описание базы, не просить пароли", init.includes("Только чтение") && init.includes("УТ 11, смоук") && init.includes("Никогда не проси пароли"), init.slice(0, 200));
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  const mnames = (manifest.tools || []).map((t) => t.name).sort();
  check("инструменты сервера = список tools в манифесте", JSON.stringify(names) === JSON.stringify(mnames), `server=${names} manifest=${mnames}`);
  check("у всех инструментов readOnlyHint: true", tools.length && tools.every((t) => t.annotations?.readOnlyHint === true), tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).join(","));
  check("нет инструментов записи (create/update/delete/post/write)", !names.some((n) => /create|update|delete|post|write|exec|insert/i.test(n)), names.join(","));

  let r = await call(c, "check_connection"); allTexts.push(r.text);
  check("check_connection: связь есть, логин принят, объекты посчитаны", !r.err && r.text.includes("логин и пароль приняты") && r.text.includes(`Опубликовано объектов: ${NAMES.length}`) && r.text.includes(VERSION), r.text);
  r = await call(c, "list_objects", { contains: "номенклатура, реализация" }); allTexts.push(r.text);
  check("list_objects: поиск по нескольким словам", r.text.includes("Catalog_Номенклатура") && r.text.includes("Document_РеализацияТоваровУслуг") && !r.text.includes("Catalog_Склады"), r.text);
  r = await call(c, "describe_object", { object: "Document_РеализацияТоваровУслуг" }); allTexts.push(r.text);
  check("describe_object: поля, табличная часть, связи", r.text.includes("Контрагент_Key") && r.text.includes("табличная часть") && r.text.includes('"Контрагент"'), r.text);
  r = await call(c, "describe_object", { object: "Document_РеализацияТоваровУслуг_Товары_RowType" }); allTexts.push(r.text);
  check("describe_object: строка табличной части", r.text.includes("Количество"), r.text);
  r = await call(c, "query", { object: "Document_РеализацияТоваровУслуг", select: "Number,Date,СуммаДокумента,Контрагент/Description", filter: "Posted eq true", orderby: "Date desc", top: 3 }); allTexts.push(r.text);
  let j = {}; try { j = JSON.parse(r.text); } catch {}
  const salesReq = seen.filter((s) => s.path.endsWith("Document_РеализацияТоваровУслуг")).at(-1);
  check("query: 3 строки, названия вместо GUID, служебный шум убран", j.rows === 3 && j.data?.[0]?.Контрагент?.Description === CLIENT_NAME && !r.text.includes("navigationLinkUrl") && !r.text.includes("odata.metadata"), r.text.slice(0, 300));
  check("query: в 1С ушли $select, $filter, $orderby, $top=3 и подставленный $expand=Контрагент", salesReq?.query?.$expand === "Контрагент" && salesReq.query.$top === "3" && salesReq.query.$filter === "Posted eq true" && salesReq.query.$orderby === "Date desc" && salesReq.query.$format === "json", JSON.stringify(salesReq));
  check("query: подсказка о следующей странице", r.text.includes("skip=3"), r.text.slice(-200));
  r = await call(c, "query", { object: "AccumulationRegister_ТоварыНаСкладах/Balance()", select: "Номенклатура/Description,Склад/Description,ВНаличииBalance" }); allTexts.push(r.text);
  const balReq = seen.filter((s) => s.path.endsWith("/Balance()")).at(-1);
  check("остатки: Balance() с названиями товара и склада", r.text.includes("ВНаличииBalance") && r.text.includes("Кирпич М150") && balReq?.query?.$expand === "Номенклатура,Склад", r.text + " " + JSON.stringify(balReq));
  r = await call(c, "count", { object: "Document_РеализацияТоваровУслуг", filter: "Posted eq true" }); allTexts.push(r.text);
  check("count: число с BOM разобрано", !r.err && JSON.parse(r.text).count === 42, r.text);
  r = await call(c, "query", { object: "Catalog_Контрагенты", select: "Description,Телефон", filter: `Description eq '${FILTER_SECRET}'` }); allTexts.push(r.text);
  check("персональные данные: справка про 152-ФЗ с пометкой автора", r.text.includes("152-ФЗ") && r.text.includes("Справка от автора"), r.text.slice(0, 300));

  // ---------- 4. только чтение: поведение ----------
  r = await call(c, "query", { object: "../../../admin" }); allTexts.push(r.text);
  check("выход за пределы OData (../) заблокирован", r.err && r.text.includes("Недопустимый"), r.text);
  r = await call(c, "query", { object: "Catalog_Номенклатура?$method=DELETE" }); allTexts.push(r.text);
  check("параметры в имени объекта (?$method=DELETE) заблокированы", r.err && r.text.includes("Недопустимый"), r.text);
  r = await call(c, "query", { object: `http://127.0.0.1:${DEAD}/evil/odata/standard.odata/Catalog_Номенклатура` }); allTexts.push(r.text);
  const evil = seen.some((s) => s.path.includes("evil"));
  check("полный чужой адрес в object не уводит запрос с адреса из настроек", !r.err && r.text.includes("Кирпич М150") && !evil, r.text);
  r = await call(c, "contact_author", { task: "Нужна запись заказов в 1С" }); allTexts.push(r.text);
  check("contact_author: без пароля, логина и адреса 1С", r.text.includes("Нужна запись заказов") && ![PASSWORD, USER, String(PORT), "127.0.0.1"].some((x) => decodeURIComponent(r.text).includes(x)), r.text.slice(0, 300));
});

// ---------- 5. ошибки 1С превращаются в понятный ответ ----------
await withServer(ENTRY, {}, async (c) => {
  const cases = [
    ["400: текст 1С про фильтр", { object: "Catalog_Номенклатура", filter: "НетТакогоПоля eq 1" }, ["400", "Неправильное выражение фильтра", "describe_object"]],
    ["403: нет прав", { object: "Catalog_Закрыт403" }, ["403", "Недостаточно прав"]],
    ["404: объект не найден, совет list_objects", { object: "Catalog_НетТакого" }, ["404", "list_objects"]],
    ["500: текст 1С (лицензия)", { object: "Catalog_Ошибка500" }, ["500", "лицензии"]],
    ["HTML вместо JSON: веб-клиент 1С", { object: "Catalog_Html" }, ["страницу вместо данных"]],
  ];
  for (const [label, args, must] of cases) {
    const r = await call(c, "query", args); allTexts.push(r.text);
    check("ошибка " + label, r.err && must.every((m) => r.text.includes(m)) && !STACK.test(r.text), r.text);
  }
});
for (const [label, env, must] of [
  ["401: неверный пароль", { ODATA_PASSWORD: "не тот" }, ["401", "Логин"]],
  ["502 шлюза перед 1С", { ODATA_URL: `http://127.0.0.1:${PORT}/gw502` }, ["502"]],
  ["ECONNREFUSED: порт закрыт", { ODATA_URL: `http://127.0.0.1:${DEAD}/УТ/odata/standard.odata/` }, ["отказал в соединении"]],
  ["пустой адрес OData", { ODATA_URL: "${user_config.odata_url}" }, ["Не указан адрес OData"]],
]) {
  await withServer(ENTRY, env, async (c) => {
    const q = await call(c, "count", { object: "Document_РеализацияТоваровУслуг" }); allTexts.push(q.text);
    const cc = await call(c, "check_connection"); allTexts.push(cc.text);
    check("ошибка " + label + " (query и check_connection)", q.err && must.every((m) => q.text.includes(m) || cc.text.includes(m)) && cc.text.includes("❌") && !STACK.test(q.text + cc.text), q.text + " || " + cc.text);
  });
}

// ---------- 6. только чтение и утечки по итогам всех вызовов ----------
const nonGet = seen.filter((s) => s.method !== "GET");
check("заглушка 1С получила только GET", seen.length > 10 && nonGet.length === 0, JSON.stringify(nonGet));
check("все запросы шли в публикацию OData из настроек", seen.every((s) => s.path.startsWith(DB) || s.path.startsWith("/gw502")), JSON.stringify(seen.filter((s) => !s.path.startsWith(DB)).slice(0, 3)));
const b64 = AUTH.slice(6);
const leaks = [PASSWORD, b64, CLIENT_PHONE, CLIENT_NAME, FILTER_SECRET].filter((x) => stderrAll.includes(x));
check("журнал сервера (stderr) без пароля, Basic-заголовка, данных клиента и значений фильтра", stderrAll.includes("GET") && leaks.length === 0, "утекло: " + leaks.join(", "));
check("ответы инструментов без пароля 1С", !allTexts.some((t) => t.includes(PASSWORD) || t.includes(b64)), "пароль в ответе");

// ---------- 7. релизный пакет .mcpb ----------
function findMcpb() {
  if (process.env.MCPB_CLI && fs.existsSync(process.env.MCPB_CLI)) return process.env.MCPB_CLI;
  const roots = [path.join(REPO, "node_modules", "@anthropic-ai", "mcpb")];
  const npx = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".npm"), process.env.LOCALAPPDATA ? "npm-cache/_npx" : "_npx");
  if (fs.existsSync(npx)) for (const d of fs.readdirSync(npx)) roots.push(path.join(npx, d, "node_modules", "@anthropic-ai", "mcpb"));
  for (const r of roots) { const cli = path.join(r, "dist", "cli", "cli.js"); if (fs.existsSync(cli)) return cli; }
  return null;
}
const MCPB = findMcpb();
if (!MCPB) {
  check("сборка .mcpb: найден mcpb (npx-кэш или MCPB_CLI)", false, "mcpb не найден офлайн. Один раз с сетью: npx -y @anthropic-ai/mcpb --version, или задать MCPB_CLI");
} else {
  const mcpb = (...a) => execFileSync(process.execPath, [MCPB, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tp = Date.now();
  try {
    mcpb("validate", path.join(REPO, "manifest.json"));
    check("mcpb validate manifest.json", true);
  } catch (e) { check("mcpb validate manifest.json", false, e.stdout + e.stderr); }
  // Пакуем копию: файлы репо (как в рабочем дереве, без игнорируемых git) + node_modules + приманки
  // с «секретами», которые лежат у разработчика локально. Ни одна приманка не должна попасть в пакет.
  const stage = path.join(WORK, "stage");
  const files = execFileSync("git", ["-C", REPO, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of files) { const s = path.join(REPO, f); if (!fs.existsSync(s)) continue; fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(s, path.join(stage, f)); }
  fs.cpSync(path.join(REPO, "node_modules"), path.join(stage, "node_modules"), { recursive: true });
  // сборка релиза чистит нативные модули ssh2 (npm run clean-native), повторяем
  for (const d of ["node_modules/cpu-features", "node_modules/nan", "node_modules/ssh2/lib/protocol/crypto/build"]) fs.rmSync(path.join(stage, d), { recursive: true, force: true });
  const DECOYS = { ".env": "ODATA_PASSWORD=decoy", "settings.xml": "<pw>decoy</pw>", "work/выгрузка.json": "[]", "HANDOFF.md": "decoy", "tests/hostkey1": "decoy", "dist/old.mcpb": "x", "codex/x.txt": "x", "base.bak-1c": "x" };
  for (const [f, v] of Object.entries(DECOYS)) { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.writeFileSync(path.join(stage, f), v); }
  const pkgFile = path.join(OUT, "1c-connector.mcpb");
  try {
    fs.writeFileSync(path.join(OUT, "mcpb-pack.log"), mcpb("pack", stage, pkgFile));
    const unpacked = path.join(WORK, "unpacked");
    mcpb("unpack", pkgFile, unpacked);
    const list = [];
    const walk = (d, rel = "") => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else list.push(r); } };
    walk(unpacked);
    fs.writeFileSync(path.join(OUT, "mcpb-files.txt"), list.filter((f) => !f.startsWith("node_modules/")).join("\n") + `\n(+ ${list.filter((f) => f.startsWith("node_modules/")).length} файлов node_modules)\n`);
    const must = ["manifest.json", "server/index.js", "icon.png", "LICENSE", "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", "node_modules/ssh2/package.json", "node_modules/zod/package.json"];
    check("пакет: внутри манифест, сервер, иконка и зависимости", must.every((m) => list.includes(m)), must.filter((m) => !list.includes(m)).join(", "));
    const bad = list.filter((f) => /^(\.env|settings\.xml|work\/|codex\/|HANDOFF\.md|tests\/|dist\/|docs\/|\.claude\/|\.github\/|README\.md|REVIEW\.md|package-lock\.json|.*\.bak-1c$)/.test(f));
    check("пакет: без тестов, скилла проверки, документации и локальных секретов", bad.length === 0, bad.slice(0, 10).join(", "));
    check("пакет: нативные модули ssh2 вычищены (кроссплатформенность)", !list.some((f) => /^node_modules\/(cpu-features|nan)\/|ssh2\/lib\/protocol\/crypto\/build\//.test(f)), "нативные сборки внутри");
    // запуск из распакованного пакета, как у пользователя после установки
    await withServer(path.join(unpacked, "server", "index.js"), {}, async (c) => {
      const r = await call(c, "check_connection");
      check("пакет: сервер из .mcpb стартует и видит 1С", r.text.includes("логин и пароль приняты") && r.text.includes(VERSION), r.text.slice(0, 300));
    });
  } catch (e) { check("сборка и распаковка .mcpb", false, (e.stdout || "") + (e.stderr || "") + e.message); }
  console.log(`(пакет: ${((Date.now() - tp) / 1000).toFixed(1)} с)`);
}

// ---------- итоги ----------
mock.close();
fs.writeFileSync(path.join(OUT, "smoke-transcript.txt"), transcript.join("\n"));
fs.writeFileSync(path.join(OUT, "server-stderr.log"), stderrAll);
fs.writeFileSync(path.join(OUT, "mock-requests.json"), JSON.stringify(seen.map(({ auth, ...s }) => s), null, 1));
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, "smoke-result.json"), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, seconds: (Date.now() - T0) / 1000, results }, null, 1));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
console.log(`\nSMOKE: ${results.length - failed.length}/${results.length} за ${((Date.now() - T0) / 1000).toFixed(1)} с`);
process.exit(failed.length ? 1 : 0);
