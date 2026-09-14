import fs from 'node:fs/promises';

const STOCKS = {
  NVDA: 'https://raw.githubusercontent.com/getdata-finance/nvda-5m-ohlcv-stocks-historical-data/main/NVDA_5m.csv',
  AMD: 'https://raw.githubusercontent.com/getdata-finance/amd-5m-ohlcv-stocks-historical-data/main/AMD_5m.csv',
  AVGO: 'https://raw.githubusercontent.com/getdata-finance/avgo-5m-ohlcv-stocks-historical-data/main/AVGO_5m.csv',
  AAPL: 'https://raw.githubusercontent.com/getdata-finance/aapl-5m-ohlcv-stocks-historical-data/main/AAPL_5m.csv',
  MSFT: 'https://raw.githubusercontent.com/getdata-finance/msft-5m-ohlcv-stocks-historical-data/main/MSFT_5m.csv',
};
const NAS = 'https://raw.githubusercontent.com/getdata-finance/nas100-5m-ohlcv-index-historical-data/main/NAS100_5m.csv';
const SPX = 'https://raw.githubusercontent.com/getdata-finance/spx500-5m-ohlcv-index-historical-data/main/SPX500_5m.csv';

const OPEN = 570, CLOSE = 960, OR_END = 585;
const ACCOUNT = 15000, RISK_PCT = 0.5, MAX_ALLOC = 25;
const COST_BPS_PER_SIDE = 2;
const TRAIN_FRACTION = 0.60;
const MIN_SCORE = 80;
const MIN_LEAD = 15;

const sum = a => a.reduce((x, y) => x + y, 0);
const mean = a => a.length ? sum(a) / a.length : 0;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);

function ny(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = t => p.find(x => x.type === t)?.value ?? '';
  const time = `${g('hour')}:${g('minute')}`;
  const [h, m] = time.split(':').map(Number);
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time, minute: h * 60 + m };
}
function parse(t) {
  const lines = t.trim().split(/\r?\n/), h = lines[0].split(',').map(x => x.trim().toLowerCase());
  const ix = Object.fromEntries(h.map((x, i) => [x, i])), out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const c = lines[i].split(',');
    let raw = c[ix.datetime];
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(raw)) raw += 'Z';
    const d = new Date(raw); if (Number.isNaN(d.getTime())) continue;
    const q = ny(d);
    const b = { ...q, epoch: d.getTime(), open:+c[ix.open], high:+c[ix.high], low:+c[ix.low], close:+c[ix.close], volume:+c[ix.volume] || 0 };
    if ([b.open,b.high,b.low,b.close].every(Number.isFinite)) out.push(b);
  }
  return out.sort((a,b) => a.epoch - b.epoch);
}
async function get(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'stock-dashboard-expectancy-optimizer' } });
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.text();
}
const reg = a => a.filter(b => b.minute >= OPEN && b.minute < CLOSE);
function byDate(a) {
  const m = new Map();
  for (const b of a) { if (!m.has(b.date)) m.set(b.date, []); m.get(b.date).push(b); }
  for (const v of m.values()) v.sort((a,b) => a.epoch-b.epoch);
  return m;
}
function daily(a) {
  return [...byDate(reg(a)).entries()].sort(([a],[b]) => a.localeCompare(b)).map(([date,x]) => ({
    date, open:x[0].open, high:Math.max(...x.map(z=>z.high)), low:Math.min(...x.map(z=>z.low)),
    close:x.at(-1).close, volume:sum(x.map(z=>z.volume)),
  }));
}
function ma(a,n){ return a.length<n ? null : mean(a.slice(-n).map(x=>x.close)); }
function bias(d,date){
  const p=d.filter(x=>x.date<date); if(p.length<60)return'NEUTRAL';
  const c=p.at(-1).close,a=ma(p,20),b=ma(p,60);
  return c>a&&a>b?'LONG':c<a&&a<b?'SHORT':'NEUTRAL';
}
function market(sd,nd,date){
  const s=sd.filter(x=>x.date<date),n=nd.filter(x=>x.date<date); if(s.length<50||n.length<50)return'NEUTRAL';
  const sc=s.at(-1).close,nc=n.at(-1).close,s20=ma(s,20),s50=ma(s,50),n20=ma(n,20),n50=ma(n,50);
  if(sc>s20&&s20>s50&&nc>n20&&n20>n50)return'RISK_ON';
  if(sc<s20&&s20<s50&&nc<n20&&n20<n50)return'RISK_OFF';
  return'NEUTRAL';
}
function vw(a){
  let pv=0,v=0; return a.map(b=>{const t=(b.high+b.low+b.close)/3;if(b.volume>0){pv+=t*b.volume;v+=b.volume}return v?pv/v:b.close});
}
function atr(a,n=14){
  if(a.length<=n)return null; const s=a.slice(-(n+1)),r=[];
  for(let i=1;i<s.length;i++)r.push(Math.max(s[i].high-s[i].low,Math.abs(s[i].high-s[i-1].close),Math.abs(s[i].low-s[i-1].close)));
  return mean(r);
}
function phase(m){return m<585?'OPENING':m<690?'PRIMARY':m<840?'MIDDAY':m<930?'SECONDARY':m<960?'CLOSING':'CLOSED'}
function phaseFactor(p){return p==='PRIMARY'||p==='SECONDARY'?1:p==='MIDDAY'?.6:p==='CLOSING'?.5:p==='OPENING'?.35:0}
function rvol(map,dates,date,min){
  const i=dates.indexOf(date),p=dates.slice(Math.max(0,i-10),i); if(i<0||p.length<3)return 0;
  const cur=sum((map.get(date)||[]).filter(b=>b.minute<=min).map(b=>b.volume));
  const hist=p.map(d=>sum((map.get(d)||[]).filter(b=>b.minute<=min).map(b=>b.volume))).filter(x=>x>0),av=mean(hist);
  return av?cur/av:0;
}
function bench(day,min){
  const x=day.filter(b=>b.minute<=min); if(!x.length)return{ret:null,above:null};
  const v=vw(x).at(-1); return{ret:(x.at(-1).close/x[0].open-1)*100,above:x.at(-1).close>v};
}
function metrics(x,oh,ol,rv,bm){
  const price=x.at(-1).close,v=vw(x),vwap=v.at(-1),slope=v.length>=4?v.at(-1)>v.at(-4):null;
  const a=atr(x)??Math.max(price*.002,.01),above=price>vwap,below=price<vwap,brokeH=price>oh,brokeL=price<ol,near=Math.abs(price-vwap)<=a*.35;
  const rs=bm.ret===null?null:(price/x[0].open-1)*100-bm.ret,recent=x.slice(-4);
  return{price,vwap,slope,atr:a,above,below,brokeH,brokeL,near,rs,rv,orHigh:oh,orLow:ol,recentLow:Math.min(...recent.map(b=>b.low)),recentHigh:Math.max(...recent.map(b=>b.high)),phase:phase(x.at(-1).minute),minute:x.at(-1).minute,benchmarkAboveVwap:bm.above};
}
function scoreV3(m,d,mode){
  const vs=m.rv>=2?10:m.rv>=1.5?8:m.rv>=1.2?6:m.rv>=1?3:0;
  const lr=m.rs===null?0:m.rs>=.5?10:m.rs>=.2?7:m.rs>0?4:0;
  const sr=m.rs===null?0:m.rs<=-.5?10:m.rs<=-.2?7:m.rs<0?4:0;
  let L=(d==='LONG'?10:d==='NEUTRAL'?5:0)+(mode==='RISK_ON'?15:mode==='NEUTRAL'?8:0)+(m.benchmarkAboveVwap===true?15:0)+(m.above?12:0)+(m.slope===true?8:0)+(m.brokeH?20:m.above&&m.near?12:0)+vs+lr;
  let S=(d==='SHORT'?10:d==='NEUTRAL'?3:0)+(mode==='RISK_OFF'?15:mode==='NEUTRAL'?5:0)+(m.benchmarkAboveVwap===false?15:0)+(m.below?12:0)+(m.slope===false?8:0)+(m.brokeL?20:0)+vs+sr;
  return { L:clamp(L,0,100), S:clamp(S,0,100) };
}
function direction(m,d,mode,cfg){
  const {L,S}=scoreV3(m,d,mode);
  const rs=m.rs??0;
  const longOK=m.minute>=cfg.startMinute && mode!=='RISK_OFF' && m.above && m.slope===true && m.benchmarkAboveVwap===true && rs>=cfg.minAbsRs && m.rv>=cfg.minRvol && (m.brokeH||(m.above&&m.near));
  const shortOK=cfg.allowShort && m.minute>=cfg.startMinute && d!=='LONG' && mode!=='RISK_ON' && m.below && m.slope===false && m.benchmarkAboveVwap===false && rs<=-cfg.minAbsRs && m.rv>=cfg.minRvol && m.brokeL;
  let dir='WAIT';
  if(longOK&&L>=cfg.minScore&&L-S>=cfg.minLead)dir='LONG';
  else if(shortOK&&S>=cfg.minScore&&S-L>=cfg.minLead)dir='SHORT';
  return {...m,L,S,dir};
}
function levels(s,e,cfg){
  const a=s.atr, floor=cfg.stopAtrFloor;
  if(s.dir==='LONG'){
    const c=[s.vwap-a*.25,s.orHigh-a*.2,s.recentLow-a*.1].filter(v=>v<e);
    const structural=c.length?Math.max(...c):e-a*.5;
    const st=Math.max(.01,Math.min(structural,e-a*floor)),r=Math.max(.01,e-st);
    return{stop:st,risk:r};
  }
  const c=[s.vwap+a*.25,s.orLow+a*.2,s.recentHigh+a*.1].filter(v=>v>e);
  const structural=c.length?Math.min(...c):e+a*.5;
  const st=Math.max(e+a*floor,structural),r=Math.max(.01,st-e);
  return{stop:st,risk:r};
}
function simulateFixed(day,i,s,cfg){
  const e=day[i].open,l=levels(s,e,cfg),target=s.dir==='LONG'?e+cfg.targetR*l.risk:e-cfg.targetR*l.risk;
  let out='EOD',ex=day.at(-1).close;
  for(let j=i;j<day.length;j++){
    const b=day[j];
    if(s.dir==='LONG'){
      if(b.low<=l.stop){out='STOP';ex=l.stop;break}
      if(b.high>=target){out='TARGET';ex=target;break}
    }else{
      if(b.high>=l.stop){out='STOP';ex=l.stop;break}
      if(b.low<=target){out='TARGET';ex=target;break}
    }
  }
  const grossR=s.dir==='LONG'?(ex-e)/l.risk:(e-ex)/l.risk;
  const costR=(e*(COST_BPS_PER_SIDE*2/10000))/l.risk;
  return {entry:e,stop:l.stop,risk:l.risk,outcome:out,exit:ex,grossR,netR:grossR-costR};
}
function simulatePartial(day,i,s,cfg){
  const e=day[i].open,l=levels(s,e,cfg),t1=s.dir==='LONG'?e+1.5*l.risk:e-1.5*l.risk,t2=s.dir==='LONG'?e+2*l.risk:e-2*l.risk;
  let hit1=false,remainingR=0.5,realizedR=0,out='EOD',ex=day.at(-1).close;
  for(let j=i;j<day.length;j++){
    const b=day[j];
    if(!hit1){
      if(s.dir==='LONG'){
        if(b.low<=l.stop){out='STOP';realizedR=-1;ex=l.stop;remainingR=0;break}
        if(b.high>=t1){hit1=true;realizedR=.5*1.5;ex=t1;continue}
      }else{
        if(b.high>=l.stop){out='STOP';realizedR=-1;ex=l.stop;remainingR=0;break}
        if(b.low<=t1){hit1=true;realizedR=.5*1.5;ex=t1;continue}
      }
    }else{
      if(s.dir==='LONG'){
        if(b.low<=e){out='TP1_BE';ex=e;realizedR+=0;remainingR=0;break}
        if(b.high>=t2){out='TP2';ex=t2;realizedR+=.5*2;remainingR=0;break}
      }else{
        if(b.high>=e){out='TP1_BE';ex=e;realizedR+=0;remainingR=0;break}
        if(b.low<=t2){out='TP2';ex=t2;realizedR+=.5*2;remainingR=0;break}
      }
    }
  }
  if(remainingR>0){
    const tail=s.dir==='LONG'?(ex-e)/l.risk:(e-ex)/l.risk;
    realizedR += remainingR*tail;
  }
  const costR=(e*(COST_BPS_PER_SIDE*2/10000))/l.risk;
  return {entry:e,stop:l.stop,risk:l.risk,outcome:out,exit:ex,grossR:realizedR,netR:realizedR-costR};
}
function simulate(day,i,s,cfg){return cfg.exitMode==='partial' ? simulatePartial(day,i,s,cfg) : simulateFixed(day,i,s,cfg)}

function stats(t,key='netR'){
  const vals=t.map(x=>x[key]),w=vals.filter(x=>x>0),l=vals.filter(x=>x<0),pr=sum(w),nr=-sum(l);
  let eq=0,peak=0,maxDdR=0,ls=0,maxLs=0;
  for(const r of vals){eq+=r;peak=Math.max(peak,eq);maxDdR=Math.max(maxDdR,peak-eq);if(r<0){ls++;maxLs=Math.max(maxLs,ls)}else ls=0}
  return {trades:t.length,wins:w.length,losses:l.length,winRate:t.length?w.length/t.length*100:0,avgR:mean(vals),totalR:sum(vals),profitFactor:nr?pr/nr:null,maxDrawdownR:maxDdR,maxLossStreak:maxLs};
}
function symbolStats(t){
  const symbols=[...new Set(t.map(x=>x.symbol))];
  return Object.fromEntries(symbols.map(s=>[s,stats(t.filter(x=>x.symbol===s))]));
}

function devObjective(trades){
  const s=stats(trades), by=symbolStats(trades), vals=Object.values(by), positive=vals.filter(x=>x.avgR>0).length;
  const dispersion=vals.length?Math.sqrt(mean(vals.map(x=>(x.avgR-mean(vals.map(y=>y.avgR)))**2))):0;
  const lowTradePenalty=s.trades<70?(70-s.trades)*0.008:0;
  const concentrationPenalty=Math.max(0,4-positive)*0.07;
  const ddPenalty=Math.max(0,s.maxDrawdownR-10)*0.012;
  return s.avgR + Math.min(s.profitFactor??0,2)*0.035 - dispersion*0.12 - lowTradePenalty - concentrationPenalty - ddPenalty;
}

function phaseAllowed(minute,mode){
  if(mode==='PRIMARY') return minute>=600&&minute<690;
  if(mode==='PRIMARY_SECONDARY') return (minute>=600&&minute<690)||(minute>=840&&minute<930);
  return minute>=600;
}
function directionV4(m,d,mode,cfg){
  const {L,S}=scoreV3(m,d,mode),rs=m.rs??0;
  const longDaily=cfg.longDaily==='ANY'||(cfg.longDaily==='NOT_SHORT'&&d!=='SHORT')||(cfg.longDaily==='LONG_ONLY'&&d==='LONG');
  const shortDaily=cfg.shortDaily==='NON_LONG'&&d!=='LONG'||cfg.shortDaily==='SHORT_ONLY'&&d==='SHORT';
  const longSetup=cfg.longSetup==='BREAKOUT_ONLY'?m.brokeH:(m.brokeH||(m.above&&m.near));
  const longOK=phaseAllowed(m.minute,cfg.phaseMode)&&longDaily&&mode!=='RISK_OFF'&&m.above&&m.slope===true&&m.benchmarkAboveVwap===true&&rs>=cfg.minAbsRs&&m.rv>=cfg.minRvol&&longSetup;
  const shortOK=cfg.shortDaily!=='OFF'&&phaseAllowed(m.minute,cfg.phaseMode)&&shortDaily&&mode!=='RISK_ON'&&m.below&&m.slope===false&&m.benchmarkAboveVwap===false&&rs<=-cfg.minAbsRs&&m.rv>=cfg.minRvol&&m.brokeL;
  let dir='WAIT';
  if(longOK&&L>=80&&L-S>=15)dir='LONG';
  else if(shortOK&&S>=80&&S-L>=15)dir='SHORT';
  return {...m,L,S,dir};
}
function prepareSymbolV4(symbol,stock,nas,spx){
  const sb=byDate(reg(stock)),nb=byDate(reg(nas)),xb=byDate(reg(spx)),dates=[...sb.keys()].sort(),sd=daily(stock),nd=daily(nas),xd=daily(spx),sessions=[];
  for(const date of dates){
    const day=sb.get(date),bd=nb.get(date); if(!day||!bd||!xb.has(date))continue;
    const op=day.filter(b=>b.minute>=OPEN&&b.minute<OR_END); if(op.length<3)continue;
    const oh=Math.max(...op.map(b=>b.high)),ol=Math.min(...op.map(b=>b.low)),d=bias(sd,date),mode=market(xd,nd,date),candidates=[];
    for(let i=0;i<day.length-1;i++){
      const b=day[i];if(b.minute<OR_END)continue;const bm=bench(bd,b.minute);if(bm.ret===null)continue;
      candidates.push({i,metrics:metrics(day.slice(0,i+1),oh,ol,rvol(sb,dates,date,b.minute),bm),dailyBias:d,marketMode:mode});
    }
    sessions.push({symbol,date,day,candidates});
  }
  return sessions;
}
function runSessionsV4(allSessions,cfg){
  const trades=[];
  for(const sess of allSessions){
    for(const c of sess.candidates){
      const sig=directionV4(c.metrics,c.dailyBias,c.marketMode,cfg);if(sig.dir==='WAIT')continue;
      const sim=simulate(sess.day,c.i+1,sig,cfg);
      trades.push({symbol:sess.symbol,date:sess.date,signalTime:sess.day[c.i].time,entryTime:sess.day[c.i+1].time,direction:sig.dir,longScore:sig.L,shortScore:sig.S,rvol:sig.rv,rs:sig.rs,dailyBias:c.dailyBias,marketMode:c.marketMode,...sim});break;
    }
  }
  return trades.sort((a,b)=>a.date.localeCompare(b.date)||a.symbol.localeCompare(b.symbol));
}
function gridV4(){
  const out=[];
  for(const minRvol of [1.2,1.5])
  for(const minAbsRs of [0,0.1])
  for(const stopAtrFloor of [.5,.65])
  for(const targetR of [1.5,1.75,2])
  for(const phaseMode of ['ALL_AFTER_10','PRIMARY_SECONDARY','PRIMARY'])
  for(const longDaily of ['ANY','NOT_SHORT','LONG_ONLY'])
  for(const shortDaily of ['NON_LONG','SHORT_ONLY','OFF'])
  for(const longSetup of ['BREAKOUT_OR_PULLBACK','BREAKOUT_ONLY'])
    out.push({startMinute:600,minScore:80,minLead:15,minRvol,minAbsRs,stopAtrFloor,allowShort:shortDaily!=='OFF',exitMode:'fixed',targetR,phaseMode,longDaily,shortDaily,longSetup});
  return out;
}
function rollingFolds(sessions){
  const dates=[...new Set(sessions.map(s=>s.date))].sort();
  const bounds=[0,.25,.5,.75,1].map(x=>Math.floor(dates.length*x));
  return [0,1,2,3].map(i=>new Set(dates.slice(bounds[i],bounds[i+1]||dates.length)));
}
function foldScore(sessions,cfg,folds){
  const foldStats=folds.map(set=>stats(runSessionsV4(sessions.filter(s=>set.has(s.date)),cfg)));
  const avg=mean(foldStats.map(x=>x.avgR)),positive=foldStats.filter(x=>x.avgR>0).length,worst=Math.min(...foldStats.map(x=>x.avgR));
  return {foldStats,avg,worst,positive,score:avg+worst*.35+positive*.03};
}

async function main(){
  const DEV={
    NVDA:'https://raw.githubusercontent.com/getdata-finance/nvda-5m-ohlcv-stocks-historical-data/main/NVDA_5m.csv',
    AMD:'https://raw.githubusercontent.com/getdata-finance/amd-5m-ohlcv-stocks-historical-data/main/AMD_5m.csv',
    AVGO:'https://raw.githubusercontent.com/getdata-finance/avgo-5m-ohlcv-stocks-historical-data/main/AVGO_5m.csv',
    AAPL:'https://raw.githubusercontent.com/getdata-finance/aapl-5m-ohlcv-stocks-historical-data/main/AAPL_5m.csv',
    MSFT:'https://raw.githubusercontent.com/getdata-finance/msft-5m-ohlcv-stocks-historical-data/main/MSFT_5m.csv',
  };
  const TEST={
    GOOG:'https://raw.githubusercontent.com/getdata-finance/goog-5m-ohlcv-stocks-historical-data/main/GOOG_5m.csv',
    TSLA:'https://raw.githubusercontent.com/getdata-finance/tsla-5m-ohlcv-stocks-historical-data/main/TSLA_5m.csv',
  };
  const [nasTxt,spxTxt]=await Promise.all([get(NAS),get(SPX)]),nas=parse(nasTxt),spx=parse(spxTxt);
  async function loadMap(map){const rows=[];for(const[symbol,url]of Object.entries(map)){try{rows.push([symbol,parse(await get(url))])}catch(e){console.warn(`Skipping ${symbol}: ${e.message}`)}}return rows}
  const devRows=await loadMap(DEV),testRows=await loadMap(TEST);if(devRows.length<5||testRows.length<2)throw Error('Missing development/test datasets');
  const devSessions=[],testSessions=[];
  for(const[sym,stock]of devRows){console.log('Preparing dev',sym);devSessions.push(...prepareSymbolV4(sym,stock,nas,spx))}
  for(const[sym,stock]of testRows){console.log('Preparing untouched',sym);testSessions.push(...prepareSymbolV4(sym,stock,nas,spx))}
  const folds=rollingFolds(devSessions),grid=gridV4();console.log(`Testing ${grid.length} v4 configs across 4 walk-forward folds`);
  const ranked=[];let n=0;
  for(const cfg of grid){const t=runSessionsV4(devSessions,cfg),s=stats(t),f=foldScore(devSessions,cfg,folds),obj=devObjective(t)+f.score*.45;ranked.push({cfg,objective:obj,dev:s,devBySymbol:symbolStats(t),folds:f});if(++n%250===0)console.log(`${n}/${grid.length}`)}
  ranked.sort((a,b)=>b.objective-a.objective);const top=ranked.slice(0,20),champion=top[0];
  const baseline={startMinute:600,minScore:80,minLead:15,minRvol:1.2,minAbsRs:0,stopAtrFloor:.5,allowShort:true,exitMode:'fixed',targetR:1.75,phaseMode:'ALL_AFTER_10',longDaily:'ANY',shortDaily:'NON_LONG',longSetup:'BREAKOUT_OR_PULLBACK'};
  const baseDev=runSessionsV4(devSessions,baseline),baseTest=runSessionsV4(testSessions,baseline),champDev=runSessionsV4(devSessions,champion.cfg),champTest=runSessionsV4(testSessions,champion.cfg);
  const topTest=top.map(x=>{const tt=runSessionsV4(testSessions,x.cfg);return{...x,untouched:stats(tt),untouchedBySymbol:symbolStats(tt)}});
  const robust=topTest.filter(x=>x.untouched.avgR>0&&(x.untouched.profitFactor??0)>1).length;
  const report={methodology:{developmentSymbols:Object.keys(DEV),untouchedSymbols:Object.keys(TEST),costStress:`${COST_BPS_PER_SIDE} bps/side`,selection:'Parameters selected on 5 development symbols using aggregate + 4 contiguous fold stability. GOOG/TSLA never participate in ranking.',caveats:['All symbols still use NASDAQ-100 proxy for intraday benchmark','5m OHLCV cannot reconstruct sub-bar path or historical spread']},baseline:{config:baseline,development:stats(baseDev),developmentBySymbol:symbolStats(baseDev),untouched:stats(baseTest),untouchedBySymbol:symbolStats(baseTest)},champion:{config:champion.cfg,development:stats(champDev),developmentBySymbol:symbolStats(champDev),folds:champion.folds,untouched:stats(champTest),untouchedBySymbol:symbolStats(champTest)},robustness:{top20PositiveUntouched:robust,top20Count:20},top20:topTest};
  await fs.rm('backtest-output-v4',{recursive:true,force:true});await fs.mkdir('backtest-output-v4',{recursive:true});
  await fs.writeFile('backtest-output-v4/v4-robustness.json',JSON.stringify(report,null,2));
  await fs.writeFile('backtest-output-v4/top20-v4.csv',['rank,minRvol,minAbsRs,stopAtrFloor,targetR,phaseMode,longDaily,shortDaily,longSetup,devTrades,devAvgR,devPF,devDD,untouchedTrades,untouchedAvgR,untouchedPF,untouchedDD',...topTest.map((x,i)=>[i+1,x.cfg.minRvol,x.cfg.minAbsRs,x.cfg.stopAtrFloor,x.cfg.targetR,x.cfg.phaseMode,x.cfg.longDaily,x.cfg.shortDaily,x.cfg.longSetup,x.dev.trades,x.dev.avgR,x.dev.profitFactor,x.dev.maxDrawdownR,x.untouched.trades,x.untouched.avgR,x.untouched.profitFactor,x.untouched.maxDrawdownR].join(','))].join('\n'));
  console.log('BASE untouched',report.baseline.untouched,report.baseline.untouchedBySymbol);console.log('CHAMP cfg',report.champion.config);console.log('CHAMP dev',report.champion.development);console.log('CHAMP folds',report.champion.folds);console.log('CHAMP untouched',report.champion.untouched,report.champion.untouchedBySymbol);console.log('Top20 positive untouched',`${robust}/20`);
}
main().catch(e=>{console.error(e);process.exit(1)});
