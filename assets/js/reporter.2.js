
(function(){
  const KEY='maintenance_reporter_local_submissions_v1';
  // 1.10: كان السطر 11 يفحص 'مغلق' بينما السطر 44 يكتب 'مفتوح' دائماً،
  // فكان عدّاد «بلاغات مغلقة» بنيوياً عاجزاً عن أن يأخذ أي قيمة غير صفر،
  // و«مفتوحة» كانت محسوبة طرحاً (length - closed) لا عدّاً. ثابتان واحدان
  // يمنعان تعارضَ النصّين من التكرار. المظهر لا يتغيّر: كل بلاغ محلي «مفتوح».
  const STATUS_OPEN='مفتوح';
  const STATUS_CLOSED='مغلق';
  const read=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return[]}};
  const save=(rows)=>localStorage.setItem(KEY,JSON.stringify(rows));
  const esc=v=>String(v??'').replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));
  const iso=d=>{const x=new Date(d);return isNaN(x)?'':x.toISOString().slice(0,10)};
  window.refreshReporterAnalytics=function(){
    const from=document.getElementById('reporter-from')?.value||'', to=document.getElementById('reporter-to')?.value||'';
    const rows=read().filter(x=>(!from||x.date>=from)&&(!to||x.date<=to));
    const closed=rows.filter(x=>x.status===STATUS_CLOSED).length, open=rows.filter(x=>x.status===STATUS_OPEN).length;
    const depts=new Set(rows.map(x=>x.dept).filter(Boolean)).size, specs=new Set(rows.map(x=>x.spec).filter(Boolean)).size;
    // 0.8: كان السطر التالي بلا حاشية فارغ بينما السطر الذي بعده يحمي عنصراً آخر.
    // النتيجة: TypeError على كل تحميل للصفحة العامة، وموت كل وحدة التحليلات.
    const kpis=document.getElementById('reporter-kpis');
    if(!kpis)return;
    kpis.innerHTML=[['إجمالي البلاغات',rows.length],['بلاغات مغلقة',closed],['بلاغات مفتوحة',open],['الأقسام',depts],['التخصصات',specs]].map(x=>`<div class="rounded-2xl border bg-slate-50 p-4"><div class="text-xs text-slate-500 font-bold">${x[0]}</div><div class="text-2xl font-black text-slate-800 mt-1">${x[1]}</div></div>`).join('');
    const body=document.querySelector('#reporter-analytics-table tbody'); if(!body)return;
    body.innerHTML=rows.map((x,i)=>`<tr><td class="border p-2 text-center">${i+1}</td><td class="border p-2" dir="ltr">${esc(x.remoteId)}</td><td class="border p-2" dir="ltr">${esc(x.date)}</td><td class="border p-2" dir="ltr">${esc(x.time)}</td><td class="border p-2">${esc(x.dept)}</td><td class="border p-2">${esc(x.spec)}</td><td class="border p-2">${esc(x.location)}</td><td class="border p-2">${esc(x.reporter)}</td><td class="border p-2">${esc(x.desc)}</td></tr>`).join('') || '<tr><td colspan="9" class="border p-6 text-center text-slate-400">لا توجد بيانات ضمن الفترة</td></tr>';
  };
  window.reporterAnalyticsRange=function(range){
    const now=new Date(), to=iso(now), fromEl=document.getElementById('reporter-from'), toEl=document.getElementById('reporter-to');
    if(range==='all'){fromEl.value='';toEl.value='';}
    else if(range==='today'){fromEl.value=to;toEl.value=to;}
    else if(range==='week'){const d=new Date(now);const day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);fromEl.value=iso(d);toEl.value=to;}
    else if(range==='month'){fromEl.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;toEl.value=to;}
    refreshReporterAnalytics();
  };
  window.exportReporterAnalyticsExcel=function(){
    const table=document.getElementById('reporter-analytics-table'); if(!table)return;
    const html=`<html><head><meta charset="UTF-8"></head><body dir="rtl"><h2>تقرير لوحة بيانات البلاغات</h2>${table.outerHTML}</body></html>`;
    const blob=new Blob(['\ufeff',html],{type:'application/vnd.ms-excel'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='تقرير_بلاغات_الصيانة.xls';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };
  window.printReporterAnalytics=function(){
    const layer=document.getElementById('reporter-analytics');if(!layer)return;
    const w=window.open('','_blank','width=1200,height=900');if(!w)return;
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير البلاغات</title><style>body{font-family:Arial,Tahoma,sans-serif;margin:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:6px;font-size:10px}h1{font-size:20px}</style></head><body><h1>لوحة بيانات البلاغات ومؤشرات الأداء</h1>${layer.outerHTML}<script>window.onload=()=>setTimeout(()=>window.print(),300);<\/script></body></html>`);w.document.close();
  };
  const form=document.getElementById('report-form');
  if(form)form.addEventListener('submit',()=>{
    const now=new Date();
    const selected=document.querySelector('input[name="spec"]:checked');
    const deptValue=document.getElementById('dept')?.value==='__custom__' ? document.getElementById('dept-custom')?.value : document.getElementById('dept')?.value;
    const snapshot={remoteId:'PUB-'+Date.now(),date:now.toLocaleDateString('en-CA'),time:now.toLocaleTimeString('ar-SA'),dept:deptValue||'',spec:selected?.value||'',location:document.getElementById('location')?.value||'',reporter:document.getElementById('reporter')?.value||'',desc:document.getElementById('desc')?.value||'',status:STATUS_OPEN};
    setTimeout(()=>{ const rows=read(); rows.unshift(snapshot); save(rows.slice(0,2000)); refreshReporterAnalytics(); },250);
  });
  document.addEventListener('DOMContentLoaded',()=>refreshReporterAnalytics());
})();
