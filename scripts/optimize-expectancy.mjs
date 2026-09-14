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
        if(b.low<=e){out='TP1_BE';ex=e;remainingR=0;break}
        if(b.high>=t2){out='TP2';ex=t2;realizedR+=.5*2;remainingR=0;break}
      }else{
        if(b.high>=e){out='TP1_BE';ex=e;remainingR=0;break}
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
function objective(trades){
  const s=stats(trades), by=symbolStats(trades), positive=Object.values(by).filter(x=>x.avgR>0).length;
  const lowTradePenalty=s.trades<40?(40-s.trades)*0.01:0;
  const concentrationPenalty=Math.max(0,3-positive)*0.08;
  const ddPenalty=Math.max(0,s.maxDrawdownR-8)*0.015;
  return s.avgR + Math.min(s.profitFactor??0,2)*0.04 - lowTradePenalty - concentrationPenalty - ddPenalty;
}
function prepareSymbol(symbol,stock,nas,spx,globalDates){
  const sb=byDate(reg(stock)),nb=byDate(reg(nas)),xb=byDate(reg(spx)),dates=[...sb.keys()].sort(),sd=daily(stock),nd=daily(nas),xd=daily(spx);
  const sessions=[];
  for(const date of globalDates){
    const day=sb.get(date),bd=nb.get(date); if(!day||!bd||!xb.has(date))continue;
    const op=day.filter(b=>b.minute>=OPEN&&b.minute<OR_END); if(op.length<3)continue;
    const oh=Math.max(...op.map(b=>b.high)),ol=Math.min(...op.map(b=>b.low)),d=bias(sd,date),mode=market(xd,nd,date),candidates=[];
    for(let i=0;i<day.length-1;i++){
      const b=day[i]; if(b.minute<OR_END)continue;
      const bm=bench(bd,b.minute); if(bm.ret===null)continue;
      const m=metrics(day.slice(0,i+1),oh,ol,rvol(sb,dates,date,b.minute),bm);
      candidates.push({i,metrics:m,dailyBias:d,marketMode:mode});
    }
    sessions.push({symbol,date,day,candidates});
  }
  return sessions;
}
function runSessions(allSessions,cfg,dateSet){
  const trades=[];
  for(const sess of allSessions){
    if(dateSet && !dateSet.has(sess.date))continue;
    for(const c of sess.candidates){
      const sig=direction(c.metrics,c.dailyBias,c.marketMode,cfg); if(sig.dir==='WAIT')continue;
      const sim=simulate(sess.day,c.i+1,sig,cfg);
      trades.push({symbol:sess.symbol,date:sess.date,signalTime:sess.day[c.i].time,entryTime:sess.day[c.i+1].time,direction:sig.dir,longScore:sig.L,shortScore:sig.S,rvol:sig.rv,rs:sig.rs,...sim});
      break;
    }
  }
  return trades.sort((a,b)=>a.date.localeCompare(b.date)||a.symbol.localeCompare(b.symbol));
}
function makeGrid(){
  const out=[];
  for(const startMinute of [585,600,615])
  for(const minScore of [80,85])
  for(const minLead of [15,20])
  for(const minRvol of [0,1,1.2])
  for(const minAbsRs of [0,0.1,0.2])
  for(const stopAtrFloor of [0.35,0.50])
  for(const allowShort of [true,false])
  for(const exitMode of ['fixed','partial']){
    if(exitMode==='partial') out.push({startMinute,minScore,minLead,minRvol,minAbsRs,stopAtrFloor,allowShort,exitMode,targetR:1.5});
    else for(const targetR of [1.25,1.5,1.75,2.0]) out.push({startMinute,minScore,minLead,minRvol,minAbsRs,stopAtrFloor,allowShort,exitMode,targetR});
  }
  return out;
}
async function main(){
  const [nasTxt,spxTxt]=await Promise.all([get(NAS),get(SPX)]),nas=parse(nasTxt),spx=parse(spxTxt);
  const rows=[];
  for(const [symbol,url] of Object.entries(STOCKS)){
    try{rows.push([symbol,parse(await get(url))])}catch(e){console.warn(`Skipping ${symbol}: ${e.message}`)}
  }
  if(!rows.length)throw new Error('No stock data');
  const dateSets=rows.map(([,stock])=>new Set([...byDate(reg(stock)).keys()]));
  const nasDates=new Set([...byDate(reg(nas)).keys()]),spxDates=new Set([...byDate(reg(spx)).keys()]);
  const globalDates=[...dateSets[0]].filter(d=>dateSets.every(s=>s.has(d))&&nasDates.has(d)&&spxDates.has(d)).sort();
  const splitIndex=Math.max(1,Math.floor(globalDates.length*TRAIN_FRACTION));
  const trainDates=globalDates.slice(0,splitIndex),validDates=globalDates.slice(splitIndex);
  const trainSet=new Set(trainDates),validSet=new Set(validDates);
  const sessions=[];
  for(const [symbol,stock] of rows){ console.log(`Preparing ${symbol}`); sessions.push(...prepareSymbol(symbol,stock,nas,spx,globalDates)); }
  const baselineCfg={startMinute:585,minScore:80,minLead:15,minRvol:0,minAbsRs:0,stopAtrFloor:.35,allowShort:true,exitMode:'fixed',targetR:1.5};
  const baselineTrain=runSessions(sessions,baselineCfg,trainSet), baselineValid=runSessions(sessions,baselineCfg,validSet);
  const grid=makeGrid(); console.log(`Testing ${grid.length} configurations`);
  const ranked=[]; let n=0;
  for(const cfg of grid){
    const trades=runSessions(sessions,cfg,trainSet), s=stats(trades), by=symbolStats(trades), obj=objective(trades);
    ranked.push({cfg,objective:obj,train:s,positiveSymbols:Object.values(by).filter(x=>x.avgR>0).length,bySymbol:by});
    n++; if(n%250===0)console.log(`  ${n}/${grid.length}`);
  }
  ranked.sort((a,b)=>b.objective-a.objective);
  const topTrain=ranked.slice(0,20), champion=topTrain[0];
  const championValidTrades=runSessions(sessions,champion.cfg,validSet), championAllTrades=runSessions(sessions,champion.cfg,new Set(globalDates));
  const evaluatedTop=topTrain.map(x=>{const vt=runSessions(sessions,x.cfg,validSet);return {...x,validation:stats(vt),validationBySymbol:symbolStats(vt)}});
  const robustNeighbors=evaluatedTop.filter(x=>x.validation.avgR>0&&((x.validation.profitFactor??0)>1)).length;
  const report={
    methodology:{sample:`${globalDates[0]} to ${globalDates.at(-1)}`,sessions:globalDates.length,train:`${trainDates[0]} to ${trainDates.at(-1)}`,validation:`${validDates[0]} to ${validDates.at(-1)}`,trainFraction:TRAIN_FRACTION,costStress:`${COST_BPS_PER_SIDE} bps per side (4 bps round trip) subtracted in R`,selection:'Champion selected ONLY by training objective. Validation is untouched until after selection.',objective:'avg net R + small PF reward - low trade count - symbol concentration - excessive drawdown penalties',limitations:['Public 5m datasets use provider volume semantics; historical bid/ask and SIP ticks unavailable','NASDAQ-100/SPX proxies are used instead of historical QQQ/SPY/SOXX 5m data','One trade max per symbol per day; same-bar stop/target assumes stop first']},
    baseline:{config:baselineCfg,train:stats(baselineTrain),validation:stats(baselineValid),trainBySymbol:symbolStats(baselineTrain),validationBySymbol:symbolStats(baselineValid)},
    champion:{config:champion.cfg,training:champion.train,trainingBySymbol:champion.bySymbol,validation:stats(championValidTrades),validationBySymbol:symbolStats(championValidTrades),all:stats(championAllTrades),allBySymbol:symbolStats(championAllTrades)},
    robustness:{top20TrainConfigsWithPositiveValidation:robustNeighbors,top20Count:evaluatedTop.length},top20:evaluatedTop,
  };
  await fs.rm('backtest-output-optimize',{recursive:true,force:true});
  await fs.mkdir('backtest-output-optimize',{recursive:true});
  await fs.writeFile('backtest-output-optimize/expectancy-optimization.json',JSON.stringify(report,null,2));
  await fs.writeFile('backtest-output-optimize/champion-trades.csv',['symbol,date,signalTime,entryTime,direction,longScore,shortScore,rvol,rs,entry,stop,risk,outcome,exit,grossR,netR',...championAllTrades.map(t=>[t.symbol,t.date,t.signalTime,t.entryTime,t.direction,t.longScore,t.shortScore,t.rvol,t.rs,t.entry,t.stop,t.risk,t.outcome,t.exit,t.grossR,t.netR].join(','))].join('\n'));
  await fs.writeFile('backtest-output-optimize/top20.csv',['rank,startMinute,minScore,minLead,minRvol,minAbsRs,stopAtrFloor,allowShort,exitMode,targetR,trainTrades,trainAvgR,trainPF,trainDD,validTrades,validAvgR,validPF,validDD,positiveTrainSymbols',...evaluatedTop.map((x,i)=>[i+1,x.cfg.startMinute,x.cfg.minScore,x.cfg.minLead,x.cfg.minRvol,x.cfg.minAbsRs,x.cfg.stopAtrFloor,x.cfg.allowShort,x.cfg.exitMode,x.cfg.targetR,x.train.trades,x.train.avgR,x.train.profitFactor,x.train.maxDrawdownR,x.validation.trades,x.validation.avgR,x.validation.profitFactor,x.validation.maxDrawdownR,x.positiveSymbols].join(','))].join('\n'));
  console.log('\nBASELINE validation', report.baseline.validation);
  console.log('CHAMPION config', report.champion.config);
  console.log('CHAMPION training', report.champion.training);
  console.log('CHAMPION validation', report.champion.validation);
  console.log('CHAMPION validation by symbol', report.champion.validationBySymbol);
  console.log('Robust top20 positive validation', `${robustNeighbors}/${evaluatedTop.length}`);
}
main().catch(e=>{console.error(e);process.exit(1)});
