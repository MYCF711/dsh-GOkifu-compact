import fs from "node:fs";
import path from "node:path";
const root = "D:/DeepSeek Harness/home/chess-context/sessions";
let total=0, objNodes=0, latestObj=0, files=0, noLatest=0;
for(const d of fs.readdirSync(root,{withFileTypes:true})){
  if(!d.isDirectory()) continue;
  const f=path.join(root,d.name,"graph.json");
  if(!fs.existsSync(f)) continue;
  files++;
  let g; try{ g=JSON.parse(fs.readFileSync(f,"utf8")); }catch(e){ continue; }
  const agents=Object.values(g.nodes||{}).filter(n=>n&&n.kind==="agent");
  total+=agents.length;
  objNodes+=agents.filter(n=>n.worldHash&&typeof n.worldHash==="object").length;
  // latest agent by order
  let latest=null;
  for(const id of (g.order||[])){ const n=g.nodes?.[id]; if(n&&n.kind==="agent") latest=n; }
  if(!latest) noLatest++;
  else if(latest.worldHash&&typeof latest.worldHash==="object") latestObj++;
}
console.log(JSON.stringify({files,totalAgentNodes:total,objectWorldHash:objNodes,latestIsObject:latestObj,noLatest},null,1));
