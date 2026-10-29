import fs from "node:fs";
const asar='D:/DeepSeek Harness/resources/app.asar';
const buf=fs.readFileSync(asar);
const hs=buf.readUInt32LE(12);
const header=JSON.parse(buf.toString('utf8',16,16+hs));
const base=16+hs;
const hits=[];
function walk(node,prefix){
  for(const [name,val] of Object.entries(node.files||{})){
    const p=prefix?prefix+'/'+name:name;
    if(val.files) walk(val,p);
    else if(/\.js$/.test(p)&&p.includes('@deepseek-ai')){
      const s=buf.subarray(base+parseInt(val.offset,10), base+parseInt(val.offset,10)+val.size).toString('utf8');
      if(s.includes('startsSeries')) hits.push(p+'  hits='+(s.split('startsSeries').length-1));
    }
  }
}
walk(header,'');
console.log(hits.join('\n'));
