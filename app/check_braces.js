const fs = require('fs');
const c = fs.readFileSync('src/app/api/generate/[id]/stream/route.ts', 'utf8');
const idx = c.indexOf('export async function GET');
console.log('GET starts at:', idx);
if(idx >= 0){
  let o=0, cl=0;
  for(let i=idx; i<c.length; i++){
    if(c[i]==='{') o++;
    if(c[i]==='}') cl++;
    if(cl > o) console.log('Extra } at', i);
    if(o===cl && o>0){
      console.log('Balanced at', i);
      break;
    }
  }
  console.log('Open:', o, 'Close:', cl, 'Diff:', o-cl);