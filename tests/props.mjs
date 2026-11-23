// Тесты на правила (property-based, fast-check): сервер коннектора запускается по stdio, как в приложении,
// а вместо 1С отвечает заглушка в этом же процессе. fast-check сам придумывает сотни входов, ищет тот,
// на котором правило ломается, и ужимает его до короткого примера.
//
//   node tests/props.mjs            # полный прогон (по умолчанию 200 случаев на правило)
//   node tests/props.mjs --quick    # короткий режим для verify (25 случаев на правило, секунды)
//   PROPS_RUNS=1000 PROPS_SEED=123 node tests/props.mjs   # больше случаев или повтор упавшего прогона
//
// Падение правила не подгоняем под код: это баг. Известные баги, которые пока не исправлены, перечислены
// в KNOWN_BUGS (подробности в tests/BUGS.md): такое правило обязано падать; когда баг починят,
// тест попросит снять пометку. Файл одинаковый в 1c-connector и 1c-chatgpt-connector.
import fc from "fast-check";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import util from "node:util";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
// PROPS_SERVER: другой файл сервера (например, нарочно испорченная копия, чтобы убедиться, что правила её ловят)
const SERVER = process.env.PROPS_SERVER ? path.resolve(process.env.PROPS_SERVER) : path.join(dir, "..", "server", "index.js");
const QUICK = process.argv.includes("--quick") || process.env.PROPS_QUICK === "1";
const RUNS = Number(process.env.PROPS_RUNS) || (QUICK ? 25 : 200);
const SEED = /^\d+$/.test(process.env.PROPS_SEED || "") ? Number(process.env.PROPS_SEED) : Date.now() % 2 ** 31;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "c1props-"));

// Известные баги: имя правила, номер в tests/BUGS.md и чем именно правило должно падать.
// Правило из списка обязано падать, и только так: другое падение (таймаут, новая ошибка) считается провалом.
const KNOWN_BUGS = {
  "битый символ в строке: ошибка по-русски": { why: "BUGS.md №1: «URI malformed» вместо русского текста", expect: /ошибка без русского текста: "URI malformed"/ },
  "поле __proto__ в ответе 1С не теряется": { why: "BUGS.md №2: поле с именем __proto__ пропадает из ответа", expect: /данные изменились:[\s\S]*ждали .*"__proto__"/ },
};

// ---------- заглушка 1С ----------
const BASE = "/Тест/odata/standard.odata";
const USER = "props.reader", PASS = "Пр0в-пароль 'x'";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`, "utf8").toString("base64");
const reqs = [];
let handler = null; // (rel, query, req) => {status, body, type} | null
const send = (res, code, body, type = "application/json;charset=utf-8") => { res.writeHead(code, { "content-type": type }); res.end(body); };
const mock = http.createServer((req, res) => {
  let bodyLen = 0;
  req.on("data", (d) => { bodyLen += d.length; });
  req.on("end", () => {
    const qi = req.url.indexOf("?");
    const rawPath = qi < 0 ? req.url : req.url.slice(0, qi);
    const rawQuery = qi < 0 ? "" : req.url.slice(qi + 1);
    let p = null;
    try { p = decodeURIComponent(rawPath); } catch {}
    reqs.push({ method: req.method, rawPath, rawQuery, path: p, headers: req.headers, bodyLen });
    if (req.method !== "GET") return send(res, 405, "only GET", "text/plain");
    if (req.headers.authorization !== AUTH) return send(res, 401, "unauthorized", "text/plain");
    if (p === null || !(p === BASE || p.startsWith(BASE + "/"))) return send(res, 404, "<html>not found</html>", "text/html");
    const rel = p.slice(BASE.length).replace(/^\//, "");
    const r = handler?.(rel, parseQuery(rawQuery), req);
    if (r) return send(res, r.status ?? 200, r.body, r.type);
    if (rel === "") return send(res, 200, JSON.stringify({ value: [{ name: "Catalog_А", url: "Catalog_А" }] }));
    if (rel === "$metadata") return send(res, 200, `<EntityType Name="Catalog_А"><Property Name="Ref_Key" Type="Edm.Guid"/></EntityType>`, "application/xml");
    if (rel.endsWith("/$count")) return send(res, 200, "5", "text/plain");
    return send(res, 200, JSON.stringify({ value: [] }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const PORT = mock.address().port;
// Чужой адрес: та же публикация, но другой порт. Сюда коннектор не должен ходить ни при каких входах
// (иначе запрос мимо основной заглушки было бы не видно: он упал бы с сетевой ошибкой и не попал в reqs).
const foreign = [];
const alien = http.createServer((req, res) => { foreign.push(`${req.method} ${req.url}`); send(res, 200, JSON.stringify({ value: [] })); });
await new Promise((r) => alien.listen(0, "127.0.0.1", r));
const ALIEN = `127.0.0.1:${alien.address().port}`;

// Разбор строки параметров так, как это делает веб-сервер: делим по &, первое = отделяет ключ.
function parseQuery(raw) {
  const out = [];
  if (!raw) return out;
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? "" : part.slice(i + 1);
    let dv; try { dv = decodeURIComponent(v); } catch { dv = null; }
    out.push({ key: k, value: dv, raw: v });
  }
  return out;
}

// ---------- сервер коннектора ----------
const ENV = {
  ODATA_URL: `http://127.0.0.1:${PORT}${BASE}/`, ODATA_USERNAME: USER, ODATA_PASSWORD: PASS,
  DB_DESCRIPTION: "", ALLOW_SELF_SIGNED: "", SSH_HOST: "", SSH_USER: "", SSH_PASSWORD: "", SSH_KEY_PATH: "",
  ODATA_URL_2: "", ODATA_URL_3: "", BASE_NAME: "",
};
async function startServer() {
  const c = new Client({ name: "props", version: "1" });
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, HOME, USERPROFILE: HOME, ...ENV }, stderr: "pipe" });
  let stderr = "";
  t.stderr?.on("data", (d) => { stderr += d; });
  await c.connect(t);
  return { c, stderr: () => stderr, close: () => c.close() };
}
const call = async (srv, name, args = {}) => {
  const r = await srv.c.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content?.[0]?.text ?? "" };
};

// ---------- генераторы ----------
const SPECIAL = ["'", "''", '"', "%", "%25", "%27", "&", "#", "+", "=", "?", "/", "\\", " ", "\t", "\n", "\r\n", ";", ",", "(", ")", "$", "*", ":", "@", "<", ">", "{", "}", "|", "~", "`", "^", "[", "]"];
const RUS = ["а", "Я", "ё", "Ё", "й", "Ъ", "ООО «Ромашка»", "Иванов", "№", "—", "…", " "];
const INJECT = ["' or 1 eq 1 or '", "') or true or ('", "&$top=100000", "&$filter=true", "#frag", "?$method=DELETE", "$batch", "X-HTTP-Method: DELETE",
  "\r\nX-HTTP-Method: MERGE\r\n", "../", "..\\", "http://evil.example/odata/standard.odata/Catalog_X", `http://${ALIEN}${BASE}/Catalog_X`, `//${ALIEN}${BASE}/Catalog_X`, `${ALIEN}/Catalog_X`, "Catalog_X?$filter=1", "%2e%2e/%2e%2e/", "/./", "Catalog_Х/$value",
  "Balance()", "Turnovers(StartPeriod=datetime'2026-01-01T00:00:00')", "eq null", "substringof('a', Description) eq true"];
const piece = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 12 }) },
  { weight: 3, arbitrary: fc.constantFrom(...SPECIAL) },
  { weight: 3, arbitrary: fc.constantFrom(...RUS) },
  { weight: 2, arbitrary: fc.constantFrom(...INJECT) },
);
// Корректный текст (любые символы Юникода, без «битых» половинок суррогатных пар)
const text = fc.array(piece, { maxLength: 8 }).map((a) => a.join(""));
// Совсем любой текст: в том числе одиночные половинки суррогатных пар (так выглядит обрезанный эмодзи)
const LONE = fc.constantFrom("\ud800", "\udbff", "\udc00", "\udfff");
const anyText = fc.oneof(text, fc.string({ unit: "binary", maxLength: 20 }), fc.array(fc.oneof(piece, LONE), { minLength: 1, maxLength: 6 }).map((a) => a.join("")));
const ident = fc.stringMatching(/^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,20}$/);
const objName = fc.tuple(fc.constantFrom("Catalog_", "Document_", "AccumulationRegister_", "InformationRegister_", ""), ident).map(([a, b]) => a + b);
const dt = fc.date({ min: new Date("2000-01-01"), max: new Date("2099-12-31"), noInvalidDate: true }).map((d) => `datetime'${d.toISOString().slice(0, 19)}'`);
const virt = fc.oneof(
  fc.constant(""), fc.constant("/Balance()"), fc.constant("/SliceLast()"),
  dt.map((d) => `/Balance(Period=${d})`),
  fc.tuple(dt, dt).map(([a, b]) => `/Turnovers(StartPeriod=${a},EndPeriod=${b})`),
);
const validObject = fc.tuple(objName, virt).map(([a, b]) => a + b);

// ---------- проверка правил ----------
let pass = 0, failN = 0;
const fails = [];
async function prop(name, arb, body, opts = {}) {
  const t0 = Date.now();
  const known = KNOWN_BUGS[name];
  const runs = Math.round(opts.runs ?? RUNS);
  try {
    // examples: обязательные входы, их проверяем в каждом прогоне, а не только когда выпадут случайно
    await fc.assert(fc.asyncProperty(arb, body), { numRuns: runs, seed: SEED, examples: (opts.examples || []).map((x) => [x]) });
    if (known) { failN++; fails.push(name); console.log(`✘ ${name}: правило больше не падает, баг «${known.why}» починен? Снимите пометку в KNOWN_BUGS и в tests/BUGS.md`); }
    else { pass++; console.log(`✔ ${name} (${runs} случаев, ${Date.now() - t0} мс)`); }
  } catch (e) {
    // fast-check 4 кладёт исходную ошибку правила в cause, в message только контрпример
    const full = `${e?.message || e}\n${e?.cause?.message || ""}`;
    const msg = full.split("\n").filter((l) => l.trim() && !/^\s*at /.test(l) && !/^Hint:/.test(l)).slice(0, 14).join("\n    ");
    if (known && known.expect.test(full)) { pass++; console.log(`✔ ${name}: известный баг, падает как ожидалось (${known.why})`); }
    else if (known) { failN++; fails.push(name); console.log(`✘ ${name}: известный баг, но падает иначе, чем записано в KNOWN_BUGS (${known.why})
    ${msg}`); }
    else { failN++; fails.push(name); console.log(`✘ ${name}\n    ${msg}`); }
  }
}
const newReqs = (from) => reqs.slice(from);
const ALLOWED_KEYS = new Set(["$format", "$filter", "$select", "$orderby", "$top", "$skip", "$expand"]);
const hasCyr = (s) => /[А-Яа-яЁё]/.test(s);

function assertGetOnly(list, ctx) {
  for (const r of list) {
    if (r.method !== "GET") throw new Error(`в 1С ушёл ${r.method} ${r.rawPath} (${ctx})`);
    if (r.bodyLen) throw new Error(`у запроса есть тело ${r.bodyLen} байт (${ctx})`);
    for (const h of Object.keys(r.headers)) if (/^x-http-method/i.test(h)) throw new Error(`заголовок ${h} (${ctx})`);
    if (r.path === null || !(r.path === BASE + "/" || r.path.startsWith(BASE + "/"))) throw new Error(`запрос ушёл мимо публикации из настроек: ${r.rawPath} (${ctx})`);
    const keys = parseQuery(r.rawQuery).map((x) => x.key);
    for (const k of keys) if (!ALLOWED_KEYS.has(k)) throw new Error(`лишний параметр «${k}» в ${r.rawPath}?${r.rawQuery} (${ctx})`);
    if (new Set(keys).size !== keys.length) throw new Error(`параметр повторяется: ${r.rawQuery} (${ctx})`);
  }
}

console.log(`Тесты на правила: ${QUICK ? "короткий режим, " : ""}${RUNS} случаев на правило, seed ${SEED} (повтор: PROPS_SEED=${SEED})`);
const srv = await startServer();
try {
  // 1. Только чтение: что бы ни прислала модель, в 1С уходят только GET без тела и только в публикацию из настроек.
  const anyCall = fc.oneof(
    fc.record({ tool: fc.constant("query"), args: fc.record({ object: anyText, filter: anyText, select: anyText, orderby: anyText, expand: anyText,
      top: fc.integer({ min: 1, max: 5000 }), skip: fc.integer({ min: 0, max: 5000 }) }, { requiredKeys: ["object"] }) }),
    fc.record({ tool: fc.constant("count"), args: fc.record({ object: anyText, filter: anyText }, { requiredKeys: ["object"] }) }),
    fc.record({ tool: fc.constant("describe_object"), args: fc.record({ object: anyText }) }),
    fc.record({ tool: fc.constant("list_objects"), args: fc.record({ contains: anyText }, { requiredKeys: [] }) }),
    fc.record({ tool: fc.constant("contact_author"), args: fc.record({ task: anyText.filter((s) => s.length >= 3 && s.length <= 300) }) }),
    fc.record({ tool: fc.constantFrom("check_connection", "what_else"), args: fc.constant({}) }),
  );
  await prop("только GET и только в публикацию из настроек, на любых входах инструментов", anyCall, async ({ tool, args }) => {
    const from = reqs.length, fromAlien = foreign.length;
    await call(srv, tool, args);
    assertGetOnly(newReqs(from), `${tool} ${JSON.stringify(args).slice(0, 200)}`);
    if (foreign.length > fromAlien) throw new Error(`запрос ушёл на чужой адрес ${ALIEN}: ${foreign.slice(fromAlien).join(", ")} (${tool} ${JSON.stringify(args).slice(0, 200)})`);
  }, { runs: RUNS * 2, examples: INJECT.flatMap((x) => [{ tool: "query", args: { object: x } }, { tool: "count", args: { object: x, filter: x } }, { tool: "describe_object", args: { object: x } }]) });

  // 2. $filter, $select, $orderby доходят до 1С ровно такими, как их прислала модель: без лишних условий и параметров.
  await prop("filter, select, orderby доходят до 1С без изменений", fc.record({ filter: text, select: text, orderby: text, top: fc.integer({ min: 1, max: 1000 }), skip: fc.integer({ min: 0, max: 3000 }) }),
    async ({ filter, select, orderby, top, skip }) => {
      const from = reqs.length;
      const r = await call(srv, "query", { object: "Catalog_Товары", filter, select, orderby, top, skip });
      const list = newReqs(from);
      assertGetOnly(list, "query");
      if (r.err) throw new Error(`ошибка вместо запроса: ${r.text}`);
      if (list.length !== 1) throw new Error(`ожидался 1 запрос, ушло ${list.length}`);
      const q = Object.fromEntries(parseQuery(list[0].rawQuery).map((x) => [x.key, x.value]));
      // select и expand коннектор пишет без пробелов (так задумано: «Number, Date» → «Number,Date»)
      const expect = { $format: "json", $filter: filter || undefined, $select: select.replace(/\s+/g, "") || undefined, $orderby: orderby || undefined, $top: String(top), $skip: skip > 0 ? String(skip) : undefined };
      for (const [k, v] of Object.entries(expect)) if (q[k] !== v) throw new Error(`${k}: ушло ${JSON.stringify(q[k])}, ждали ${JSON.stringify(v)}; строка ${list[0].rawQuery}`);
      if (list[0].path !== BASE + "/Catalog_Товары") throw new Error(`путь ${list[0].path}`);
    });

  await prop("count: filter доходит до 1С без изменений", text, async (filter) => {
    const from = reqs.length;
    await call(srv, "count", { object: "Catalog_Товары", filter });
    const list = newReqs(from);
    assertGetOnly(list, "count");
    if (list.length !== 1 || list[0].path !== BASE + "/Catalog_Товары/$count") throw new Error(`запросы: ${list.map((x) => x.rawPath).join(", ")}`);
    const q = parseQuery(list[0].rawQuery);
    const f = q.find((x) => x.key === "$filter")?.value;
    if (f !== (filter || undefined)) throw new Error(`$filter ушёл ${JSON.stringify(f)}, ждали ${JSON.stringify(filter)}`);
    if (q.length !== (filter ? 1 : 0)) throw new Error(`лишние параметры: ${list[0].rawQuery}`);
  });

  // 3. Строковый литерал OData с апострофами (удвоенными по правилам OData), кавычками, %, &, #, кириллицей:
  //    1С получает ровно одно условие и разбирает литерал обратно в исходную строку.
  await prop("строка в кавычках OData: 1С разбирает ту же строку, лишних условий нет", text, async (s) => {
    const filter = `Description eq '${s.replace(/'/g, "''")}' and DeletionMark eq false`;
    let parsed = null;
    handler = (rel, q) => {
      const f = q.find((x) => x.key === "$filter")?.value ?? "";
      const m = f.match(/^Description eq '((?:[^']|'')*)' and DeletionMark eq false$/s);
      parsed = m ? m[1].replace(/''/g, "'") : { bad: f };
      return { body: JSON.stringify({ value: [] }) };
    };
    try { await call(srv, "query", { object: "Catalog_Контрагенты", filter }); } finally { handler = null; }
    if (parsed !== s) throw new Error(`1С разобрала ${JSON.stringify(parsed)}, ждали ${JSON.stringify(s)}`);
  });

  // 4. Имя объекта: правильное имя (с Balance(), Turnovers(...), SliceLast()) доходит до 1С как есть,
  //    любое другое либо отклоняется без запроса, либо остаётся внутри публикации и не добавляет параметров.
  await prop("правильное имя объекта доходит до 1С как есть", validObject, async (object) => {
    const from = reqs.length;
    const r = await call(srv, "query", { object, top: 1 });
    const list = newReqs(from);
    assertGetOnly(list, object);
    if (r.err || list.length !== 1) throw new Error(`ответ ${r.text.slice(0, 200)}, запросов ${list.length}`);
    if (list[0].path !== `${BASE}/${object}`) throw new Error(`в 1С ушёл путь ${list[0].path}`);
  });
  await prop("любое имя объекта: без запроса или внутри публикации без лишних параметров", anyText, async (object) => {
    const from = reqs.length, fromAlien = foreign.length;
    const r = await call(srv, "query", { object, top: 1 });
    const list = newReqs(from);
    assertGetOnly(list, JSON.stringify(object));
    if (foreign.length > fromAlien) throw new Error(`запрос ушёл на чужой адрес: ${foreign.slice(fromAlien).join(", ")}`);
    if (/[?#]|:\/\/|\.\.|\\/.test(object.replace(/^.*\/odata\/standard\.odata\//i, "")) && list.length) throw new Error(`недопустимое имя ушло в 1С: ${list[0].rawPath}`);
    if (!list.length && !r.err) throw new Error(`нет запроса и нет ошибки: ${r.text.slice(0, 200)}`);
  }, { examples: [...INJECT, ...SPECIAL.map((x) => "Catalog_A" + x + "B")] });

  // 5. Любой ввод даёт понятный ответ по-русски: ошибка без английских внутренностей Node.
  const russianErrors = async ({ object, filter }) => {
    for (const tool of ["query", "count"]) {
      const r = await call(srv, tool, { object, filter });
      if (r.err && !hasCyr(r.text)) throw new Error(`${tool}: ошибка без русского текста: ${JSON.stringify(r.text)}`);
    }
  };
  await prop("на любой ввод ошибка понятна по-русски", fc.record({ object: text, filter: text }), russianErrors);
  // Одиночная половинка суррогатной пары (обрезанный эмодзи) в имени объекта и, отдельно, в фильтре:
  // правило падает, пока не исправлены оба места.
  await prop("битый символ в строке: ошибка по-русски", fc.record({ a: text, b: text, lone: LONE }), async ({ a, b, lone }) => {
    await russianErrors({ object: "Catalog_" + a + lone, filter: b });
    await russianErrors({ object: "Catalog_Товары", filter: "Description eq '" + a + lone + "'" });
  });

  // 6. Журнал сервера: значения фильтра и пароль не попадают в stderr (журнал прикладывают к обращениям).
  await prop("журнал без пароля и значения фильтра", fc.tuple(text, fc.uuid()), async ([s, id]) => {
    const marker = `Метка${id.replace(/-/g, "")}`;
    const before = srv.stderr().length;
    await call(srv, "query", { object: "Catalog_Контрагенты", filter: `Description eq '${marker}${s.replace(/'/g, "''")}'` });
    await call(srv, "count", { object: "Catalog_Контрагенты", filter: `ИНН eq '${marker}'` });
    const log = srv.stderr().slice(before);
    if (log.includes(marker) || log.includes(PASS)) throw new Error(`в журнале значение фильтра или пароль: ${log.slice(0, 300)}`);
  }, { runs: Math.max(10, RUNS / 4) });

  // 7. Разбор ответа OData и обратно: все поля строк доходят до модели с теми же значениями,
  //    убираются только служебные ссылки OData (odata.metadata, *@navigationLinkUrl и подобные).
  const SERVICE = (k) => k === "odata.metadata" || /@navigationLinkUrl$|@odata\.(navigationLink|associationLink)/i.test(k);
  const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !SERVICE(k)).map(([k, x]) => [k, strip(x)])) : v;
  const key = fc.oneof(
    { weight: 5, arbitrary: ident },
    { weight: 2, arbitrary: fc.constantFrom("Ref_Key", "Description", "Code", "Number", "Date", "Posted", "DeletionMark", "Контрагент_Key", "Контрагент@navigationLinkUrl", "odata.metadata", "odata.type", "Товары", "LineNumber", "constructor", "toString", "hasOwnProperty") },
    { weight: 2, arbitrary: text.filter((k) => k !== "__proto__") }, // __proto__ проверяется отдельным правилом ниже
  );
  const leaf = fc.oneof(text, fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer(), fc.boolean(), fc.constant(null), fc.uuid());
  const value = fc.letrec((tie) => ({
    v: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, fc.array(tie("o"), { maxLength: 3 }), tie("o")),
    o: fc.dictionary(key, tie("v"), { maxKeys: 5, noNullPrototype: true }),
  })).v;
  const row = fc.dictionary(key, value, { maxKeys: 8, noNullPrototype: true });
  const roundTrip = async ({ rows, bom, meta, wire: raw }) => {
    const wire = raw ?? JSON.stringify({ ...(meta ? { "odata.metadata": "http://x/$metadata#Catalog_Т" } : {}), value: rows });
    const sent = JSON.parse(wire).value; // ровно то, что увидит любой разборщик JSON
    handler = (rel) => rel === "Catalog_Т" ? { body: (bom ? "\ufeff" : "") + wire } : null;
    let r;
    try { r = await call(srv, "query", { object: "Catalog_Т", top: 1000 }); } finally { handler = null; }
    if (r.err) throw new Error(`ошибка: ${r.text}`);
    const j = JSON.parse(r.text);
    const expect = JSON.parse(JSON.stringify(strip(sent)));
    if (j.rows !== sent.length) throw new Error(`строк ${j.rows}, ждали ${sent.length}`);
    if (!util.isDeepStrictEqual(j.data, expect)) throw new Error(`данные изменились:\n  пришло ${JSON.stringify(j.data).slice(0, 400)}\n  ждали  ${JSON.stringify(expect).slice(0, 400)}`);
  };
  await prop("разбор ответа OData: поля и значения строк не теряются", fc.record({ rows: fc.array(row, { maxLength: 12 }), bom: fc.boolean(), meta: fc.boolean() }), roundTrip);
  // Поле с именем __proto__ (JSON.parse отдаёт его как обычное поле) на верхнем уровне строки или в табличной части.
  await prop("поле __proto__ в ответе 1С не теряется", fc.record({ v: value, deep: fc.boolean() }), ({ v, deep }) => {
    const inner = `{"__proto__":${JSON.stringify(v)},"Description":"x"}`;
    return roundTrip({ wire: `{"value":[${deep ? `{"Товары":[${inner}]}` : inner}]}`, bom: false });
  }, { runs: Math.max(5, RUNS / 5) });

  // 8. Чтение порциями: строки не теряются и не дублируются при любых top и skip, в 1С не больше 1000 за запрос.
  await prop("чтение порциями без потерь и дублей", fc.record({ total: fc.integer({ min: 0, max: 2600 }), top: fc.integer({ min: 1, max: 3000 }), skip: fc.integer({ min: 0, max: 3000 }) }), async ({ total, top, skip }) => {
    const from = reqs.length;
    handler = (rel, q) => {
      if (rel !== "Catalog_Много") return null;
      const t = Number(q.find((x) => x.key === "$top")?.value ?? 100), s = Number(q.find((x) => x.key === "$skip")?.value ?? 0);
      return { body: JSON.stringify({ value: Array.from({ length: Math.max(0, Math.min(t, total - s)) }, (_, i) => ({ Ref_Key: `k${s + i}`, N: s + i })) }) };
    };
    let r;
    try { r = await call(srv, "query", { object: "Catalog_Много", top, skip }); } finally { handler = null; }
    const j = JSON.parse(r.text);
    const want = Array.from({ length: Math.max(0, Math.min(Math.min(top, 1000), total - skip)) }, (_, i) => skip + i);
    const got = j.data.map((x) => x.N);
    if (!util.isDeepStrictEqual(got, want)) throw new Error(`строки ${got.slice(0, 5)}… (${got.length}), ждали ${want.slice(0, 5)}… (${want.length})`);
    for (const x of newReqs(from)) { const t = Number(parseQuery(x.rawQuery).find((y) => y.key === "$top")?.value); if (!(t >= 1 && t <= 1000)) throw new Error(`$top=${t} за запрос`); }
    if (top > 1000 && !j.limit) throw new Error("нет пояснения про предел бесплатной версии");
  });

  // 9. count: число из ответа 1С (с BOM, пробелами, переводом строки) доходит без искажений.
  await prop("count: число из ответа доходит без искажений", fc.record({ n: fc.oneof(fc.integer({ min: 0, max: 2 ** 31 }), fc.maxSafeInteger().filter((x) => x >= 0)), pre: fc.constantFrom("", "\ufeff", " ", "\n"), post: fc.constantFrom("", "\r\n", " ") }), async ({ n, pre, post }) => {
    handler = (rel) => rel === "Catalog_Ч/$count" ? { body: pre + n + post, type: "text/plain" } : null;
    let r;
    try { r = await call(srv, "count", { object: "Catalog_Ч" }); } finally { handler = null; }
    const j = JSON.parse(r.text);
    if (j.count !== n) throw new Error(`count ${j.count}, ждали ${n}`);
  });
} finally { await srv.close(); }

// 10. describe_object: все поля из $metadata в том же порядке и с теми же типами, у похожих имён поля не путаются.
//     Метаданные кэшируются на запуск сервера, поэтому на каждый случай свой запуск: случаев меньше.
const EDM = ["Edm.String", "Edm.Guid", "Edm.Boolean", "Edm.DateTime", "Edm.Double", "Edm.Int64", "Edm.Int16", "Edm.Binary", "Edm.Stream"];
const fieldsArb = fc.uniqueArray(fc.record({ name: ident, type: fc.oneof(fc.constantFrom(...EDM), ident.map((t) => `Collection(StandardODATA.${t})`)) }), { selector: (f) => f.name, minLength: 1, maxLength: 15 });
await prop("describe_object: поля из $metadata без потерь", fc.record({ name: objName, fields: fieldsArb, noise: fieldsArb }), async ({ name, fields, noise }) => {
  const ent = (n, fs) => `<EntityType Name="${n}"><Key><PropertyRef Name="Ref_Key"/></Key>${fs.map((f) => `<Property Name="${f.name}" Type="${f.type}" Nullable="true"/>`).join("")}<NavigationProperty Name="Связь" Relationship="x" FromRole="a" ToRole="b"/></EntityType>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx><edmx:DataServices><Schema Namespace="StandardODATA">${ent(name + "_RowType", noise)}${ent("X" + name, noise)}${ent(name, fields)}${ent(name + "Старый", noise)}</Schema></edmx:DataServices></edmx:Edmx>`;
  handler = (rel) => rel === "$metadata" ? { body: xml, type: "application/xml" } : null;
  const s = await startServer();
  try {
    const r = await call(s, "describe_object", { object: name });
    const j = JSON.parse(r.text);
    const want = fields.map((f) => ({ name: f.name, type: f.type.replace(/^Collection\(StandardODATA\.(.+)\)$/, "табличная часть: $1") }));
    if (!util.isDeepStrictEqual(j.fields, want)) throw new Error(`поля ${JSON.stringify(j.fields).slice(0, 300)}, ждали ${JSON.stringify(want).slice(0, 300)}`);
  } finally { handler = null; await s.close(); }
}, { runs: QUICK ? 4 : 25 });

mock.close(); alien.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\nСВОЙСТВА: ${pass} прошло, ${failN} упало (seed ${SEED})`);
if (failN) console.log("Упали:", fails.join("; "));
process.exit(failN ? 1 : 0);
