import { decodePNG } from './png.mjs';
import { readdirSync } from 'node:fs';
const dir = process.argv[2] || 'shots/r6';
const srgb2lin = (v)=>{ const c=v/255; return c<=0.04045? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
const files = readdirSync(dir).filter(f=>f.endsWith('.png')).sort();
const rows=[];
for (const f of files) {
  const { width:w, height:h, data } = decodePNG(dir+'/'+f);
  // snow population: bottom 55%, sat<0.30, B>=R-4, max>55
  const pop=[];
  let satSum=0, satN=0, lumaAll=[];
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const i=(y*w+x)*3, R=data[i],G=data[i+1],B=data[i+2];
    const mx=Math.max(R,G,B), mn=Math.min(R,G,B);
    const s = mx? (mx-mn)/mx : 0;
    satSum+=s; satN++;
    const L=0.2126*R+0.7152*G+0.0722*B;
    lumaAll.push(L);
    if (y >= h*0.45 && s<0.30 && B>=R-4 && mx>55) pop.push([R,G,B,L]);
  }
  pop.sort((a,b)=>a[3]-b[3]);
  const q=(p)=>pop[Math.min(pop.length-1,Math.max(0,Math.round(p*(pop.length-1))))];
  const sun=q(0.93), sha=q(0.10);
  const lin=(c)=>[srgb2lin(c[0]),srgb2lin(c[1]),srgb2lin(c[2])];
  const ls=lin(sun), lh=lin(sha);
  const Lu=(c)=>0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
  const hex=(c)=>'#'+c.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
  lumaAll.sort((a,b)=>a-b);
  // near/far tile sigma
  const tile=32; const bands=[[0,0.25],[0.75,1.0]];
  const sig=bands.map(([a,b])=>{
    let acc=0,n=0;
    for(let ty=Math.floor(h*a); ty+tile<=Math.floor(h*b); ty+=tile)
      for(let tx=0; tx+tile<=w; tx+=tile){
        let s=0,s2=0;
        for(let y=ty;y<ty+tile;y++)for(let x=tx;x<tx+tile;x++){
          const i=(y*w+x)*3; const L=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];
          s+=L; s2+=L*L;
        }
        const m=s/(tile*tile); acc+=Math.sqrt(Math.max(0,s2/(tile*tile)-m*m)); n++;
      }
    return n? acc/n : 0;
  });
  rows.push({
    f: f.replace('.png',''),
    sunlit: hex(sun), shadow: hex(sha),
    sunBR:(sun[2]/sun[0]).toFixed(3), shaBR:(sha[2]/sha[0]).toFixed(3),
    fill:(Lu(lh)/Lu(ls)).toFixed(3),
    ch9: ((lh[2]/ls[2])/(lh[0]/ls[0])).toFixed(3),
    meanSat:(satSum/satN).toFixed(3),
    medLuma: lumaAll[Math.round(lumaAll.length*0.5)].toFixed(0),
    p999: lumaAll[Math.round(lumaAll.length*0.999)].toFixed(0),
    farSig: sig[0].toFixed(2), nearSig: sig[1].toFixed(2), nf: (sig[1]/Math.max(1e-6,sig[0])).toFixed(2),
  });
}
console.table(rows);
