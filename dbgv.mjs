import puppeteer from 'puppeteer-core';
import {resolve} from 'path';
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const b=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--enable-unsafe-webgpu','--use-angle=metal','--no-sandbox']});
const p=await b.newPage();await p.setViewport({width:800,height:600});
let fmtMismatch=0;const errs=[];
p.on('console',m=>{const t=m.text();if(/does not match the color att/.test(t))fmtMismatch++;else if(m.type()==='error'&&!/Invalid CommandBuffer|404/.test(t))errs.push(t);});
p.on('pageerror',e=>errs.push('PE:'+e.message));
await p.goto('http://localhost:4371/?nohdr',{waitUntil:'networkidle0'});
await new Promise(r=>setTimeout(r,500));
await (await p.$('#fileInput')).uploadFile(resolve('public/equirect.uhdr.jpg'));
await p.evaluate(()=>document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})));
await new Promise(r=>setTimeout(r,6000));
async function sample(lat){await p.evaluate(l=>window.__setView(0,l),lat);await new Promise(r=>setTimeout(r,400));const buf=await (await p.$('#view')).screenshot({encoding:'binary'});return p.evaluate(async d=>{const img=new Image();await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src='data:image/png;base64,'+d});const c=document.createElement('canvas');c.width=16;c.height=16;const x=c.getContext('2d');x.drawImage(img,0,0,16,16);const px=x.getImageData(0,0,16,16).data;let s=0;for(let i=0;i<px.length;i+=4)s+=px[i]+px[i+1]+px[i+2];return Math.round(s/(16*16*3))},buf.toString('base64'));}
const up=await sample(85),down=await sample(-85);
console.log('UP:',up,'DOWN:',down,'| upright?',up>down,'| fmtMismatch:',fmtMismatch,'| errors:',JSON.stringify(errs.slice(0,3)));
await p.evaluate(()=>window.__setView(0,0));await new Promise(r=>setTimeout(r,400));
await p.screenshot({path:'test/shot_gm.png'});
await b.close();
