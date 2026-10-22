import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { findCatalog, findScholarship, portals } from "./providers";

const reply=(x:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(x)}]});
function createServer() {
  const s=new McpServer({name:"atlas-scholarly-sources",version:"0.1.0"});
  s.registerTool("list_source_portals",{description:"List reputable Sanskrit/Vedic discovery portals; these are links, not claims that their text APIs are connected.",inputSchema:{}},async()=>reply({status:"directory_only",sources:portals}));
  s.registerTool("find_catalog_entries",{description:"Search public Wikidata catalogue entities for a work, edition, person, or title. Results are leads only, not verified Sanskrit witnesses.",inputSchema:{query:z.string().trim().min(2).max(160)}},async({query})=>{try{return reply(await findCatalog(query))}catch(e){return {isError:true,...reply({status:"provider_error",message:String(e)})}}});
  s.registerTool("search_scholarly_literature",{description:"Search Crossref scholarly publications. Bibliographic metadata only; do not treat results as independently verified manuscript readings.",inputSchema:{query:z.string().trim().min(2).max(160)}},async({query})=>{try{return reply(await findScholarship(query))}catch(e){return {isError:true,...reply({status:"provider_error",message:String(e)})}}});
  return s;
}
const handler=createMcpHandler(createServer);
export default {
  fetch(request:Request,env:unknown,ctx:ExecutionContext):Promise<Response> | Response {
    const url=new URL(request.url);
    if(url.pathname==="/health") return Response.json({status:"ok",service:"atlas-scholarly-sources",version:"0.1.0"});
    if(url.pathname!=="/mcp") return new Response("Not found",{status:404});
    return handler(request,env,ctx);
  }
};
