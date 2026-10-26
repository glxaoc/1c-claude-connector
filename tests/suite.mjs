import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "c1home-"));
const GOOD = { ODATA_URL:"http://127.0.0.1:8766/УТ11/odata/standard.odata/", ODATA_USERNAME:"odata.user", ODATA_PASSWORD:"p@ss word",
  DB_DESCRIPTION:"${user_config.db_description}", ALLOW_SELF_SIGNED:"${user_config.allow_self_signed}",
  SSH_HOST:"${user_config.ssh_host}", SSH_USER:"${user_config.ssh_user}", SSH_PASSWORD:"${user_config.ssh_password}", SSH_KEY_PATH:"${user_config.ssh_key}" };
const SSHOK = { SSH_HOST:"127.0.0.1:2224", SSH_USER:"deploy", SSH_PASSWORD:"srv pass" };
let pass=0, failN=0; const fails=[];
async function withClient(env, fn){
  const c = new Client({name:"t",version:"1"});
  await c.connect(new StdioClientTransport({command:"node",args:[new URL("../server/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,"$1")],env:{...process.env,HOME,USERPROFILE:HOME,...GOOD,...env},stderr:"pipe"}));
  try { return await fn(c); } finally { await c.close(); }
}
const call = async (c,n,a={}) => { const r = await c.callTool({name:n,arguments:a}); return { err: !!r.isError, text: r.content[0].text }; };
function check(name, cond, detail){ if (cond) { pass++; console.log("✔", name); } else { failN++; fails.push(name); console.log("✘", name, "\n   ", String(detail).slice(0,400).replace(/\n/g," | ")); } }

// 1. грязные адреса OData
for (const [label, url] of [
  ["адрес без окончания", "http://127.0.0.1:8766/УТ11"],
  ["адрес с двойным слэшем", "http://127.0.0.1:8766/УТ11//odata/standard.odata/"],
  ["адрес без http", "127.0.0.1:8766/УТ11/odata/standard.odata"],
  ["адрес с пробелами", "  http://127.0.0.1:8766/УТ11/odata/standard.odata/  "],
  ["адрес с $metadata", "http://127.0.0.1:8766/УТ11/odata/standard.odata/$metadata"],
  ["адрес с объектом и параметрами", "http://127.0.0.1:8766/УТ11/odata/standard.odata/Catalog_Номенклатура?$format=json"],
  ["кириллица закодирована", "http://127.0.0.1:8766/%D0%A3%D0%A211/odata/standard.odata/"],
]) await withClient({ODATA_URL:url}, async c => { const r = await call(c,"check_connection"); check("URL: "+label, r.text.includes("логин и пароль приняты"), r.text); });

// 2. логин/пароль
await withClient({ODATA_USERNAME:" odata.user "}, async c => { const r = await call(c,"check_connection"); check("логин с пробелами по краям", r.text.includes("приняты"), r.text); });
await withClient({ODATA_PASSWORD:"wrong"}, async c => { const r = await call(c,"check_connection"); check("неверный пароль 1С → понятная ошибка", r.text.includes("401"), r.text); });

// 3. работа с данными
await withClient({DB_DESCRIPTION:"УТ 11, стройматериалы"}, async c => {
  const init = c.getInstructions?.() || "";
  check("инструкции для Claude + описание базы", init.includes("Balance()") && init.includes("стройматериалы"), init.slice(0,200));
  let r = await call(c,"list_objects"); check("1900+ объектов → группы, а не простыня", r.text.includes("groups") && r.text.length < 20000, r.text.length);
  r = await call(c,"list_objects",{contains:"реализация, номенклатура"}); check("поиск по нескольким словам", r.text.includes("Document_РеализацияТоваровУслуг") && r.text.includes("Catalog_Номенклатура"), r.text);
  r = await call(c,"list_objects",{contains:"несуществующее"}); check("пустой поиск → подсказка", r.text.includes("Ничего не найдено"), r.text);
  r = await call(c,"describe_object",{object:"Document_РеализацияТоваровУслуг"}); check("поля + табличная часть + expand", r.text.includes("табличная часть") && r.text.includes("Контрагент"), r.text);
  r = await call(c,"describe_object",{object:"Document_РеализацияТоваровУслуг_Товары_RowType"}); check("описание строки табличной части", r.text.includes("Количество"), r.text);
  r = await call(c,"describe_object",{object:"Document_Реализация"}); check("неточное имя → похожие варианты", r.text.includes("Похожие") , r.text);
  await call(c,"describe_object",{object:"Catalog_Мусор1"});
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",top:500}); check("огромный ответ обрезается с подсказкой", r.text.includes("ответ обрезан") && r.text.length < 160000, r.text.length);
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",top:5}); check("служебные поля OData вычищены, BOM не мешает", !r.text.includes("navigationLinkUrl") && r.text.includes("00-1"), r.text.slice(0,200));
  check("подсказка о следующей странице", r.text.includes("skip=5"), r.text.slice(-200));
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",filter:"НетТакого eq 'BAD'"}); check("ошибка фильтра → текст 1С", r.err && r.text.includes("Неправильное выражение фильтра"), r.text);
  r = await call(c,"query",{object:"Catalog_Ошибка500"}); check("500 → текст 1С (лицензия)", r.text.includes("лицензии"), r.text);
  r = await call(c,"query",{object:"Catalog_НетТакого"}); check("404 объекта → подсказка", r.text.includes("list_objects"), r.text);
  r = await call(c,"query",{object:"AccumulationRegister_ТоварыНаСкладах/Balance(Period=datetime'2026-09-30T23:59:59')"}); check("Balance с параметром даты", r.text.includes("ВНаличииBalance"), r.text);
  r = await call(c,"query",{object:"http://127.0.0.1:8766/УТ11/odata/standard.odata/AccumulationRegister_ТоварыНаСкладах/Balance()"}); check("полный адрес вместо имени объекта", r.text.includes("ВНаличииBalance"), r.text);
  r = await call(c,"query",{object:"../../etc/passwd"}); check("попытка выйти за OData заблокирована", r.err && r.text.includes("Недопустимый"), r.text);
  r = await call(c,"count",{object:"Document_РеализацияТоваровУслуг"}); check("count с BOM", r.text.includes("1234"), r.text);
});
// кэш метаданных
await withClient({}, async c => { await call(c,"describe_object",{object:"Catalog_Мусор1"}); await call(c,"describe_object",{object:"Catalog_Мусор2"}); await call(c,"describe_object",{object:"Catalog_Мусор3"}); });
const hits = await (await fetch("http://127.0.0.1:8766/УТ11/odata/standard.odata/metahits",{headers:{Authorization:"Basic "+Buffer.from("odata.user:p@ss word").toString("base64")}})).text();

// 4. неправильные адреса
await withClient({ODATA_URL:"http://127.0.0.1:8766/redir"}, async c => { const r = await call(c,"check_connection"); check("редирект на том же сервере", r.text.includes("приняты"), r.text); });
await withClient({ODATA_URL:"http://127.0.0.1:8766/gw502"}, async c => { const r = await call(c,"check_connection"); check("502 → объяснение", r.text.includes("502"), r.text); });
await withClient({ODATA_URL:"http://127.0.0.1:8766/НетБазы"}, async c => { const r = await call(c,"check_connection"); check("неверное имя базы → 404 с подсказкой", r.text.includes("имя базы"), r.text); });
await withClient({ODATA_URL:"https://127.0.0.1:8766/УТ11"}, async c => { const r = await call(c,"check_connection"); check("https на http-порту → совет сменить на http", /http:\/\/|https/.test(r.text) && r.text.includes("❌"), r.text); });
await withClient({ODATA_URL:"http://no-such-host-1c.invalid/УТ11"}, async c => { const r = await call(c,"check_connection"); check("несуществующий домен", r.text.includes("не найден"), r.text); });
await withClient({ODATA_URL:""}, async c => { const r = await call(c,"check_connection"); check("пустой адрес", r.text.includes("Не указан адрес"), r.text); });
await withClient({}, async c => { const r = await call(c,"check_connection"); check("предупреждение про http без шифрования (для публичных адресов)", true, r.text); });

// 5. SSH
await withClient({}, async c => {
  let r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",select:"Number, Контрагент/Description",top:2}); check("expand подставляется из select", r.text.includes('"_expand":"Контрагент"'), r.text);
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",select:"Number,Контрагент/Description,Склад/Description",expand:"Контрагент",top:2}); check("expand: дополняется, без дублей", r.text.includes('"_expand":"Контрагент,Склад"'), r.text);
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",select:"Number,Дата",top:2}); check("expand не добавляется без путей в select", !r.text.includes("_expand"), r.text);
  r = await call(c,"query",{object:"Document_РеализацияТоваровУслуг",select:"Number,Основание/Контрагент/Description",top:2}); check("expand: вложенный путь", r.text.includes('"_expand":"Основание/Контрагент"'), r.text);
  const init = c.getInstructions?.() || ""; check("инструкции: названия вместо GUID", init.includes("Контрагент/Description"), init.slice(0,100));
});
await withClient({}, async c => {
  const r = await call(c,"check_connection"); check("check_connection: примеры вопросов и совет про описание базы", r.text.includes("Можно спрашивать обычными словами") && r.text.includes("Покажи 5 последних реализаций") && r.text.includes("описать базу одной фразой"), r.text);
});
await withClient({DB_DESCRIPTION:"УТ 11"}, async c => {
  const r = await call(c,"check_connection"); check("check_connection: без совета, если база описана", r.text.includes("Можно спрашивать") && !r.text.includes("Совет:"), r.text);
  const init = c.getInstructions?.() || ""; check("инструкции: как отвечать и запрет записи", init.includes("Как отвечать") && init.includes("Коннектор только читает") && init.includes("Никогда не проси пароли"), init.slice(0,80));
});
const TWO = { BASE_NAME:"Бухгалтерия", BASE_NAME_2:"ERP", ODATA_URL_2:"http://127.0.0.1:8766/ERP/odata/standard.odata/", ODATA_USERNAME_2:"erp.user", ODATA_PASSWORD_2:"erp pass" };
await withClient(TWO, async c => {
  let r = await call(c,"check_connection");
  check("2 базы: проверка показывает обе", r.text.includes("База «Бухгалтерия»") && r.text.includes("База «ERP»") && (r.text.match(/логин и пароль приняты/g)||[]).length === 2 && r.text.includes("подключено баз: 2 из 2"), r.text);
  r = await call(c,"count",{object:"Catalog_Склады_ERP", base:"ERP"}); check("2 базы: запрос ко второй по названию", r.text.includes("77"), r.text);
  r = await call(c,"count",{object:"Document_РеализацияТоваровУслуг", base:"бухгалтерия"}); check("2 базы: первая, название без учёта регистра", r.text.includes("1234"), r.text);
  r = await call(c,"count",{object:"Catalog_Склады_ERP", base:"2"}); check("2 базы: выбор по номеру", r.text.includes("77"), r.text);
  r = await call(c,"count",{object:"Catalog_Склады_ERP"}); check("2 базы: без base просит указать", r.err && r.text.includes("Подключено несколько баз") && r.text.includes("«ERP»"), r.text);
  r = await call(c,"count",{object:"Catalog_Склады_ERP", base:"Зарплата"}); check("2 базы: неизвестная база → список доступных", r.err && r.text.includes("не найдена") && r.text.includes("«Бухгалтерия»"), r.text);
  r = await call(c,"list_objects",{base:"ERP"}); check("2 базы: list_objects у второй", r.text.includes("Catalog_Склады_ERP") && !r.text.includes("Номенклатура"), r.text.slice(0,200));
  r = await call(c,"count",{object:"Catalog_НетТакого", base:"ERP"}); check("2 базы: ошибка с названием базы", r.err && r.text.startsWith("База «ERP»"), r.text);
  const init = c.getInstructions?.() || ""; check("2 базы: инструкции про параметр base", init.includes("Подключено несколько баз") && init.includes("base"), init.slice(0,120));
});
await withClient({...TWO, ODATA_PASSWORD_2:"wrong"}, async c => {
  const r = await call(c,"check_connection");
  check("2 базы: у второй неверный пароль, первая работает", r.text.includes("401") && r.text.includes("подключено баз: 1 из 2") && r.text.includes("приняты"), r.text);
});
await withClient({}, async c => { const r = await call(c,"count",{object:"Document_РеализацияТоваровУслуг", base:"что-то"}); check("1 база: параметр base игнорируется", r.text.includes("1234"), r.text); });
await withClient({ODATA_URL_3:"http://127.0.0.1:8766/ERP/odata/standard.odata/", ODATA_USERNAME_3:"erp.user", ODATA_PASSWORD_3:"erp pass"}, async c => {
  const r = await call(c,"check_connection"); check("3-я база без названия получает имя «База 3»", r.text.includes("База «База 3»") && r.text.includes("подключено баз: 2 из 2"), r.text);
});
await withClient({}, async c => {
  let r = await call(c,"query",{object:"Catalog_Много",select:"Description",top:1000}); let j = JSON.parse(r.text);
  check("top 1000: читается целиком и без пропусков", j.rows === 1000 && j.data[0].Description === "Товар 0" && j.data[999].Description === "Товар 999" && j.note?.includes("skip=1000") && !j.limit, r.text.slice(0,200));
  r = await call(c,"query",{object:"Catalog_Много",top:5000}); j = JSON.parse(r.text);
  check("top 5000: бесплатная версия отдаёт 1000 и говорит про автора", j.rows === 1000 && j.limit?.includes("1000") && j.limit?.includes("t.me/Ioann_d"), r.text.slice(0,200));
  r = await call(c,"query",{object:"Catalog_Много",top:1000,skip:2000}); j = JSON.parse(r.text);
  check("skip + top: конец списка", j.rows === 300 && j.data[0].Description === "Товар 2000" && !j.limit, r.text.slice(0,200));
  r = await call(c,"query",{object:"Catalog_Много",top:10}); check("ответ компактный (без отступов)", !r.text.includes("\n "), r.text.slice(0,120));
  const init = c.getInstructions?.() || ""; check("инструкции: top до 1000, итоги через Turnovers, границы бесплатной версии", init.includes("1000") && init.includes("Turnovers") && init.includes("Чего нет в бесплатной версии") && init.includes("t.me/Ioann_d"), init.slice(0,80));
});
await withClient(SSHOK, async c => { const r = await call(c,"check_connection"); check("SSH: всё верно", r.text.includes("SSH установлено") && r.text.includes("приняты"), r.text);
  const q = await call(c,"count",{object:"Document_РеализацияТоваровУслуг"}); check("SSH: запрос данных через туннель", q.text.includes("1234"), q.text); });
for (const [label, host] of [["https://", "https://127.0.0.1:2224"],["ssh://user@", "ssh://deploy@127.0.0.1:2224/"],["команда ssh -p", "ssh deploy@127.0.0.1 -p 2224"],["пробелы", " 127.0.0.1:2224 "]])
  await withClient({...SSHOK, SSH_HOST:host}, async c => { const r = await call(c,"check_connection"); check("SSH-адрес: "+label, r.text.includes("SSH установлено"), r.text); });
await withClient({...SSHOK, SSH_HOST:"ssh://deploy@127.0.0.1:2224", SSH_USER:""}, async c => { const r = await call(c,"check_connection"); check("SSH: логин взят из адреса", r.text.includes("SSH установлено"), r.text); });
await withClient({...SSHOK, SSH_USER:"deploy@127.0.0.1"}, async c => { const r = await call(c,"check_connection"); check("SSH: «логин@ip» в поле логина", r.text.includes("SSH установлено"), r.text); });
await withClient({...SSHOK, SSH_PASSWORD:"bad"}, async c => { const r = await call(c,"check_connection"); check("SSH: неверный пароль", r.text.includes("не принял логин или пароль SSH"), r.text); });
await withClient({...SSHOK, SSH_PASSWORD:""}, async c => { const r = await call(c,"check_connection"); check("SSH: нет пароля и ключа", r.text.includes("ни пароль, ни SSH-ключ"), r.text); });
await withClient({...SSHOK, SSH_USER:""}, async c => { const r = await call(c,"check_connection"); check("SSH: нет логина", r.text.includes("Логин сервера"), r.text); });
await withClient({...SSHOK, SSH_HOST:"127.0.0.1:2299"}, async c => { const r = await call(c,"check_connection"); check("SSH: сервер не слушает", r.text.includes("отказал"), r.text); });
await withClient({...SSHOK, SSH_KEY_PATH:"C:\\нет\\key"}, async c => { const r = await call(c,"check_connection"); check("SSH: файл ключа не найден", r.text.includes("файл не найден"), r.text); });
await withClient({...SSHOK, ODATA_URL:"http://127.0.0.1:8799/УТ11"}, async c => { const r = await call(c,"check_connection"); check("SSH: 1С недоступна с сервера → белый список", r.text.includes("белый список"), r.text); });
await withClient(SSHOK, async c => { const r = await call(c,"check_connection"); check("SSH: показаны методы входа при успехе", r.text.includes("Методы входа") && r.text.includes("password"), r.text); });
await withClient({...SSHOK, SSH_PASSWORD:"bad"}, async c => { const r = await call(c,"check_connection"); check("SSH: неверный пароль → методы и причина", r.text.includes("Сервер разрешает вход") && r.text.includes("password") && r.text.includes("PermitRootLogin"), r.text); });
await withClient({...SSHOK, SSH_HOST:"127.0.0.1:2225"}, async c => { const r = await call(c,"check_connection"); check("SSH: сервер только по ключу → подсказка про ключ", r.text.includes("publickey") && r.text.includes("отключён") && r.text.includes("SSH-ключ"), r.text); });
console.log("HOME", HOME, "metaHits", hits);
console.log(`\nИТОГО: ${pass} прошло, ${failN} упало`); if (failN) console.log("Упали:", fails.join("; "));
