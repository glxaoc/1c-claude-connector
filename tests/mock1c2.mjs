import http from "node:http";
const AUTH = "Basic " + Buffer.from("odata.user:p@ss word","utf8").toString("base64");
const BASE = "/УТ11/odata/standard.odata";
const names = [];
for (let i=0;i<1200;i++) names.push(`Catalog_Справочник${i}`);
for (let i=0;i<700;i++) names.push(`Document_Документ${i}`);
names.push("Catalog_Номенклатура","Catalog_Контрагенты","Document_РеализацияТоваровУслуг","AccumulationRegister_ТоварыНаСкладах","InformationRegister_ЦеныНоменклатуры");
let meta = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx><edmx:DataServices><Schema Namespace="StandardODATA">`;
for (let i=0;i<4000;i++) meta += `<EntityType Name="Catalog_Мусор${i}"><Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="Description" Type="Edm.String"/></EntityType>`;
meta += `<EntityType Name="Document_РеализацияТоваровУслуг"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/><Property Name="Number" Type="Edm.String"/><Property Name="Date" Type="Edm.DateTime"/><Property Name="Posted" Type="Edm.Boolean"/><Property Name="Контрагент_Key" Type="Edm.Guid"/><Property Name="СуммаДокумента" Type="Edm.Double"/><Property Name="Товары" Type="Collection(StandardODATA.Document_РеализацияТоваровУслуг_Товары_RowType)" Nullable="false"/><NavigationProperty Name="Контрагент" Relationship="x" FromRole="a" ToRole="b"/></EntityType><ComplexType Name="Document_РеализацияТоваровУслуг_Товары_RowType"><Property Name="LineNumber" Type="Edm.Int64"/><Property Name="Номенклатура_Key" Type="Edm.Guid"/><Property Name="Количество" Type="Edm.Double"/></ComplexType>`;
meta += `</Schema></edmx:DataServices></edmx:Edmx>`;
let metaHits = 0;
const big = Array.from({length:500},(_, i)=>({Ref_Key:`g${i}`,Number:`00-${i}`,Date:"2026-09-01T10:00:00","Контрагент@navigationLinkUrl":`Document_X(guid'g${i}')/Контрагент`,Комментарий:"x".repeat(800)}));
const send=(res,code,body,type="application/json;charset=utf-8")=>{res.writeHead(code,{"content-type":type});res.end(body);};
http.createServer((req,res)=>{
  if (req.method!=="GET") return send(res,405,"only GET","text/plain");
  const u = new URL(req.url,"http://x");
  let p = decodeURIComponent(u.pathname);
  if (p.startsWith("/redir")) { res.writeHead(301,{location: encodeURI(BASE + "/") + u.search}); return res.end(); }
  if (p.startsWith("/УТ11/ru_RU")) return send(res,200,"<html><body>Веб-клиент 1С</body></html>","text/html");
  if (p.startsWith("/gw502")) return send(res,502,"<html>Bad Gateway</html>","text/html");
  const BASE2 = "/ERP/odata/standard.odata";
  if (p.startsWith(BASE2)) {
    if (req.headers.authorization !== "Basic " + Buffer.from("erp.user:erp pass","utf8").toString("base64")) return send(res,401,"unauthorized","text/plain");
    const q = p.slice(BASE2.length).replace(/^\//,"");
    if (q === "") return send(res,200,JSON.stringify({value:[{name:"Catalog_Склады_ERP",url:"Catalog_Склады_ERP"},{name:"Document_ЗаказПокупателя_ERP",url:"Document_ЗаказПокупателя_ERP"}]}));
    if (q === "Catalog_Склады_ERP/$count") return send(res,200,"77","text/plain");
    return send(res,404,JSON.stringify({"odata.error":{message:{value:`Не найден объект ${q}`}}}));
  }
  if (!p.startsWith(BASE)) return send(res,404,"<html>not found</html>","text/html");
  if (req.headers.authorization!==AUTH) return send(res,401,"unauthorized","text/plain");
  p = p.slice(BASE.length).replace(/^\//,"");
  const f = u.searchParams.get("$filter")||"";
  if (p==="") return send(res,200,"﻿"+JSON.stringify({"odata.metadata":"x",value:names.map(n=>({name:n,url:n}))}));
  if (p==="$metadata") { metaHits++; return send(res,200,meta,"application/xml"); }
  if (p==="metahits") return send(res,200,String(metaHits),"text/plain");
  if (f.includes("BAD")) return send(res,400,JSON.stringify({"odata.error":{code:"-1",message:{lang:"ru",value:"Неправильное выражение фильтра: поле НетТакого не найдено"}}}));
  if (p==="Catalog_Ошибка500") return send(res,500,JSON.stringify({"odata.error":{code:"14",message:{value:"Нет свободной лицензии на сервере 1С"}}}));
  if (p==="Catalog_Много") {
    const top=+u.searchParams.get("$top")||100, skip=+u.searchParams.get("$skip")||0;
    const all = Array.from({length:2300},(_, i)=>({Ref_Key:`k${i}`,Description:`Товар ${i}`}));
    return send(res,200,JSON.stringify({value:all.slice(skip,skip+top)}));
  }
  if (p==="Catalog_Контрагенты") return send(res,200,JSON.stringify({value:[{Description:"ООО Тест","Телефон":"+7 900 111-22-33"}]}));
  if (p==="Document_РеализацияТоваровУслуг/$count") return send(res,200,"﻿1234","text/plain");
  if (p==="Document_РеализацияТоваровУслуг") {
    const top=+u.searchParams.get("$top")||500; return send(res,200,"﻿"+JSON.stringify({"odata.metadata":"x",value:big.slice(0,top).map((r,i)=>i===0&&u.searchParams.get("$expand")?{...r,_expand:u.searchParams.get("$expand"),_select:u.searchParams.get("$select")}:r)}));
  }
  if (p.startsWith("AccumulationRegister_ТоварыНаСкладах/Balance(")) return send(res,200,JSON.stringify({value:[{Номенклатура_Key:"1",ВНаличииBalance:12,"_p":p}]}));
  if (p==="AccumulationRegister_ТоварыНаСкладах/Balance()") return send(res,200,JSON.stringify({value:[{Номенклатура_Key:"1",ВНаличииBalance:12}]}));
  return send(res,404,JSON.stringify({"odata.error":{message:{value:`Не найден объект ${p}`}}}));
}).listen(8766,"127.0.0.1",()=>console.error("mock2 up"));
