// app.js - Firebase client optimized with loaders, notifications & per-day deletion
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteField } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/* ---------- CONFIG ---------- */
const firebaseConfig = {
  apiKey: "APi",
  authDomain: "pago-mensual.firebaseapp.com",
  projectId: "pago-mensual",
  storageBucket: "pago-mensual.firebasestorage.app",
  messagingSenderId: "563116960554",
  appId: "1:563116960554:web:2546406e49db4525928c53"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ---------- SETTINGS ---------- */
const FIXED_USER = "main-user";
const MONTHS_TO_VIEW = 12;              // Ver historial completo
const MONTHS_TO_CREATE = 3;             // Crear solo últimos 3 meses
const MAX_UNPAID_MONTHS_TO_CREATE = 3;  // Bloquear si 3+ meses con deuda

/* ---------- STATE ---------- */
let currentMonthDate = new Date();
let monthlyData = {};
let priorMonthDebt = 0;
let globalCredit = 0;
let monthsWithDebtCount = 0;
let auditMode = false;

/* ---------- HELPERS ---------- */
const safeParseFloat = v => {
  if(v==null||v==="") return 0;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

function formatYM(date){ return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`; }
function monthDocPath(date){ return `artifacts/pago-mensual/users/${FIXED_USER}/monthly-data/${formatYM(date)}`; }
function globalCreditPath(){ return `artifacts/pago-mensual/users/${FIXED_USER}/global-meta/credit`; }

function showLoader(){ document.getElementById('loader-overlay')?.classList.add('visible'); }
function hideLoader(){ document.getElementById('loader-overlay')?.classList.remove('visible'); }

function showNotification(msg,type='success'){
  const c = document.getElementById('notification-container');
  if(!c) return;
  const el = document.createElement('div');
  el.className = `toast ${type==='info'?'bg-blue-500':type==='warning'?'bg-yellow-500':'bg-green-500'} text-white`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(()=> { el.style.opacity='0'; setTimeout(()=>el.remove(),300); },3000);
}

function determineStatus(rec){
  const rate = safeParseFloat(rec.rate || 0);
  const payment = safeParseFloat(rec.payment || 0);
  if(payment <= 0.001) return 'worked';
  if(Math.abs(payment-rate)<0.01 || payment>=rate) return 'paid';
  return 'partially-paid';
}

/* ---------- FIRESTORE ---------- */
async function readMonthDoc(date){
  const ref = doc(db, monthDocPath(date));
  const snap = await getDoc(ref);
  if(!snap.exists()) return { days:{}, meta:{ monthlyEndBalance:0, updatedAt: Date.now() } };
  const data = snap.data();
  return { days: data.days||{}, meta: data.meta||{ monthlyEndBalance:0, updatedAt:Date.now() } };
}

async function writeMonthDoc(date, daysObj, metaObj){
  const ref = doc(db, monthDocPath(date));
  await setDoc(ref, { days: daysObj, meta: metaObj }, { merge:true });
}

/* ---------- GLOBAL CREDIT ---------- */
async function loadGlobalCredit(){
  try{
    const snap = await getDoc(doc(db, globalCreditPath()));
    globalCredit = safeParseFloat(snap.data()?.credit || 0);
    document.getElementById('global-credit-display').textContent = `S/ ${globalCredit.toFixed(2)}`;
  }catch(e){ globalCredit=0; }
}

async function saveGlobalCredit(){
  await setDoc(doc(db, globalCreditPath()), { credit: +globalCredit.toFixed(2) }, { merge:true });
  document.getElementById('global-credit-display').textContent = `S/ ${globalCredit.toFixed(2)}`;
}

/* ---------- PRIOR MONTH DEBT ---------- */
async function loadPriorMonthDebt(){
  const prev = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth()-1, 1);
  const { days } = await readMonthDoc(prev);
  let req = 0, paid = 0;
  for(const k in days){
    const r = days[k];
    if(r?.created){
      req += safeParseFloat(r.rate);
      paid += safeParseFloat(r.payment||0);
    }
  }
  priorMonthDebt = +(req - paid).toFixed(2);
  document.getElementById('prior-month-debt-display').textContent = `S/ ${priorMonthDebt.toFixed(2)}`;
}

/* ---------- COLLECT MONTHS WITH DEBT ---------- */
async function collectMonthsWithDebt(){
  const months=[];
  const today = new Date();
  for(let i=0;i<MONTHS_TO_VIEW;i++){
    const d = new Date(today.getFullYear(), today.getMonth()-i,1);
    const { days } = await readMonthDoc(d);
    let hasDebt=false; let monthDebt=0;
    for(const k in days){
      const r=days[k];
      if(r?.created){
        const rate = safeParseFloat(r.rate);
        const payment = safeParseFloat(r.payment || 0);
        const need = Math.max(0, rate - payment);
        if(need>0.01){ hasDebt=true; monthDebt+=need; }
      }
    }
    if(hasDebt) months.push({ date:d, days, debt:+monthDebt.toFixed(2) });
  }
  months.sort((a,b)=>a.date-b.date);
  monthsWithDebtCount = months.length;
  document.getElementById('months-debt-count').textContent = String(monthsWithDebtCount);
  return months;
}

/* ---------- AUDIT MODE ---------- */
async function checkAuditMode(){
  const months = await collectMonthsWithDebt();
  const now = new Date();
  const createRangeStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_TO_CREATE - 1), 1);
  
  const oldDebtMonths = months.filter(m => m.date < createRangeStart);
  
  if(oldDebtMonths.length > 0){
    auditMode = true;
    showAuditModeBanner(oldDebtMonths);
  } else {
    auditMode = false;
    hideAuditModeBanner();
  }
}

function showAuditModeBanner(oldDebtMonths){
  const existing = document.getElementById('audit-mode-banner');
  if(existing) existing.remove();
  
  const totalOldDebt = oldDebtMonths.reduce((sum, m) => sum + m.debt, 0);
  
  const banner = document.createElement('div');
  banner.id = 'audit-mode-banner';
  banner.className = 'bg-orange-100 border-l-4 border-orange-500 text-orange-700 p-4 mb-4 rounded';
  banner.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="text-3xl">🔍</span>
      <div>
        <strong class="text-lg">Modo Auditoría Activado</strong>
        <p class="text-sm mt-1">
          Tienes <strong>S/ ${totalOldDebt.toFixed(2)}</strong> de deuda en 
          <strong>${oldDebtMonths.length} mes(es)</strong> fuera del rango de creación.
        </p>
        <p class="text-sm mt-1">
          ✅ Puedes <strong>VER</strong> y <strong>PAGAR</strong> toda tu deuda histórica<br>
          ❌ No puedes <strong>CREAR</strong> nuevos días hasta saldar estas cuentas
        </p>
      </div>
    </div>
  `;
  
  document.querySelector('.max-w-6xl').prepend(banner);
}

function hideAuditModeBanner(){
  const banner = document.getElementById('audit-mode-banner');
  if(banner) banner.remove();
}

/* ---------- NAVIGATION BUTTONS ---------- */
function updateNavigationButtons(){
  const now = new Date();
  const oldestViewAllowed = new Date(now.getFullYear(), now.getMonth() - (MONTHS_TO_VIEW - 1), 1);
  const newestViewAllowed = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const prevBtn = document.getElementById('prev-month-btn');
  const prevMonth = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() - 1, 1);
  
  if(prevMonth < oldestViewAllowed){
    prevBtn.disabled = true;
    prevBtn.classList.add('opacity-50', 'cursor-not-allowed');
    prevBtn.title = 'No hay datos más antiguos';
  } else {
    prevBtn.disabled = false;
    prevBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    prevBtn.title = '';
  }
  
  const nextBtn = document.getElementById('next-month-btn');
  const nextMonth = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 1);
  
  if(nextMonth > newestViewAllowed){
    nextBtn.disabled = true;
    nextBtn.classList.add('opacity-50', 'cursor-not-allowed');
    nextBtn.title = 'No puedes ver meses futuros';
  } else {
    nextBtn.disabled = false;
    nextBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    nextBtn.title = '';
  }
}

/* ---------- APPLY PAYMENT ---------- */
async function applyPayment(amount){
  let remaining=+amount;
  const months = await collectMonthsWithDebt();
  const dayQueue = [];

  for(const m of months){
    for(const k in m.days){
      const r = m.days[k];
      if(r?.created){
        const need = Math.max(0, safeParseFloat(r.rate)-safeParseFloat(r.payment||0));
        if(need>0.01) dayQueue.push({ month:m.date, dayKey:k, rec:r });
      }
    }
  }

  dayQueue.sort((a,b)=>a.month-b.month || parseInt(a.dayKey)-parseInt(b.dayKey));

  const touched={};
  for(const item of dayQueue){
    if(remaining<=0.001) break;
    const need=Math.max(0, safeParseFloat(item.rec.rate)-safeParseFloat(item.rec.payment||0));
    if(need<=0.001) continue;
    const apply=Math.min(need,remaining);
    item.rec.payment = +(safeParseFloat(item.rec.payment||0)+apply).toFixed(2);
    item.rec.status = determineStatus(item.rec);
    remaining = +(remaining-apply).toFixed(2);
    const ym = formatYM(item.month);
    touched[ym]=touched[ym]||{};
    touched[ym][item.dayKey]=item.rec;
  }

  for(const ym in touched){
    const parts=ym.split('-');
    const d=new Date(parseInt(parts[0]),parseInt(parts[1])-1,1);
    const { days } = await readMonthDoc(d);
    const newDays = {...days, ...touched[ym]};
    let req=0, paid=0;
    for(const k in newDays){ const r=newDays[k]; if(r?.created){ req+=safeParseFloat(r.rate); paid+=safeParseFloat(r.payment||0); } }
    const meta = { monthlyEndBalance: +(req-paid).toFixed(2), updatedAt: Date.now() };
    await writeMonthDoc(d, newDays, meta);
  }

  if(remaining>0.01){
    globalCredit=+(globalCredit+remaining).toFixed(2);
    await saveGlobalCredit();
  }
  return true;
}

/* ---------- RENDER CALENDAR ---------- */
function renderCalendar(){
  const year=currentMonthDate.getFullYear();
  const month=currentMonthDate.getMonth();
  const monthName=currentMonthDate.toLocaleString('es-PE',{ month:'long', year:'numeric' });
  document.getElementById('current-month-year').textContent = monthName.charAt(0).toUpperCase()+monthName.slice(1);

  const firstDay = new Date(year,month,1).getDay();
  const daysInMonth = new Date(year,month+1,0).getDate();
  const body = document.getElementById('calendar-body');
  body.innerHTML='';

  // Verificar si es mes de solo lectura
  const now = new Date();
  const createRangeStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_TO_CREATE - 1), 1);
  const currentMonthStart = new Date(year, month, 1);
  
  const isReadOnlyMonth = currentMonthStart < createRangeStart;

  for(let i=0;i<firstDay;i++){
    const empty=document.createElement('div');
    empty.className='day-cell status-non-working';
    body.appendChild(empty);
  }

  for(let d=1;d<=daysInMonth;d++){
    const key=String(d);
    const rec=monthlyData[key];
    const cell=document.createElement('div');
    cell.className='day-cell p-2 rounded-lg shadow-sm relative';

    const dayDate = new Date(year, month, d);
    const isFutureDay = dayDate > now;

    let status='non-working';
    if(rec?.created) status=rec.status||determineStatus(rec);
    cell.classList.add(`status-${status}`);

    // Marcar días futuros
    if(isFutureDay && !rec?.created){
      cell.classList.add('opacity-50', 'cursor-not-allowed');
      cell.title = 'No puedes trabajar días futuros';
    }

    // Marcar días en mes de solo lectura
    if(isReadOnlyMonth && !rec?.created){
      cell.classList.add('opacity-50', 'cursor-not-allowed');
      cell.title = `Solo puedes crear días en los últimos ${MONTHS_TO_CREATE} meses`;
    }

    const numEl=document.createElement('div'); numEl.className='day-number'; numEl.textContent=d;
    cell.appendChild(numEl);

    const statusEl=document.createElement('div'); statusEl.className='day-status';
    statusEl.textContent=status==='worked'?'Trab.':status==='paid'?'Pagado':status==='partially-paid'?'Parcial':'Libre';
    cell.appendChild(statusEl);

    if(rec?.created){
      if(safeParseFloat(rec.payment)>0){
        const payEl=document.createElement('div'); payEl.className='day-payment';
        payEl.textContent=`S/ ${Number(rec.payment).toFixed(2)}  (Rate S/ ${Number(rec.rate).toFixed(2)})`;
        cell.appendChild(payEl);
      } else {
        const deleteBtn=document.createElement('button');
        deleteBtn.innerHTML='🗑';
        deleteBtn.title='Borrar día';
        deleteBtn.className='absolute top-1 right-1 text-red-600 hover:text-red-800';
        deleteBtn.addEventListener('click',async(e)=>{
          e.stopPropagation();
          await deleteDay(d);
        });
        cell.appendChild(deleteBtn);
      }
    }

    // Solo permitir click si no es día futuro ni mes de solo lectura
    if(!isFutureDay && !isReadOnlyMonth){
      cell.addEventListener('click',()=>{ 
        if(!rec?.created) openWorkConfirmationModal({day:d, date: new Date(year,month,d)});
        else if(rec.status!=='paid') openPaymentModal(d);
      });
    } else if(rec?.created && rec.status!=='paid'){
      // Permitir pagar días existentes incluso en meses antiguos
      cell.addEventListener('click',()=>{ openPaymentModal(d); });
      cell.classList.remove('cursor-not-allowed');
      cell.classList.add('cursor-pointer');
    }

    body.appendChild(cell);
  }

  // Mostrar banner si es mes de solo lectura
  if(isReadOnlyMonth){
    const existingBanner = body.parentElement.querySelector('.readonly-banner');
    if(!existingBanner){
      const banner = document.createElement('div');
      banner.className = 'readonly-banner bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-3 mb-4 rounded';
      banner.innerHTML = `⚠️ Este mes es de <strong>solo lectura</strong>. Solo puedes crear días en los últimos <strong>${MONTHS_TO_CREATE} meses</strong>.`;
      body.parentElement.prepend(banner);
    }
  } else {
    const existingBanner = body.parentElement.querySelector('.readonly-banner');
    if(existingBanner) existingBanner.remove();
  }
}

/* ---------- DELETE SINGLE DAY ---------- */
async function deleteDay(day){
  showLoader();
  const { days } = await readMonthDoc(currentMonthDate);
  const k = String(day);

  if(!days[k]?.created){ hideLoader(); return; }
  if(safeParseFloat(days[k].payment||0) > 0.001){
    hideLoader();
    showNotification('No se puede borrar un día con pago','warning');
    return;
  }

  const monthRef = doc(db, monthDocPath(currentMonthDate));
  await updateDoc(monthRef, { [`days.${k}`]: deleteField() });

  delete days[k];
  monthlyData = days;

  let req=0, paid=0; 
  for(const kk in days){ const r = days[kk]; if(r?.created){ req += safeParseFloat(r.rate); paid += safeParseFloat(r.payment||0); } }
  const meta = { monthlyEndBalance: +(req-paid).toFixed(2), updatedAt: Date.now() };
  await writeMonthDoc(currentMonthDate, days, meta);

  renderCalendar();
  await updateSummary();
  hideLoader();

  showNotification(`Día ${day} eliminado y marcado como libre`, 'info');
}

/* ---------- MODALS ---------- */
let selectedDayInfo=null;
function openWorkConfirmationModal(obj){
  selectedDayInfo=obj;
  const el=document.getElementById('work-modal-day');
  if(el) el.textContent=`${obj.day}/${(obj.date?.getMonth()??currentMonthDate.getMonth())+1}/${obj.date?.getFullYear()??currentMonthDate.getFullYear()}`;
  document.getElementById('work-confirmation-modal').classList.remove('hidden');
}

function openPaymentModal(day){
  selectedDayInfo={day};
  const el=document.getElementById('modal-day');
  if(el) el.textContent=`${day}/${currentMonthDate.getMonth()+1}/${currentMonthDate.getFullYear()}`;
  document.getElementById('payment-amount').value='';
  document.getElementById('payment-modal').classList.remove('hidden');
}
function closePaymentModal(){ document.getElementById('payment-modal').classList.add('hidden'); }

/* ---------- VALIDATION ---------- */
async function canCreateNewDay(date){
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  
  // Regla 1: No días futuros
  if(date > now) 
    return {ok: false, msg: 'No puedes crear días en el futuro.'};
  
  // Regla 2: Modo auditoría activo
  if(auditMode)
    return {ok: false, msg: 'Estás en Modo Auditoría. Salda tu deuda antigua antes de crear nuevos días.'};
  
  // Regla 3: Solo últimos MONTHS_TO_CREATE meses
  const createRangeStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_TO_CREATE - 1), 1);
  const dateMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  
  if(dateMonth < createRangeStart)
    return {ok: false, msg: `Solo puedes crear días en los últimos ${MONTHS_TO_CREATE} meses.`};
  
  // Regla 4: Máximo MAX_UNPAID_MONTHS_TO_CREATE meses con deuda
  const months = await collectMonthsWithDebt();
  if(months.length >= MAX_UNPAID_MONTHS_TO_CREATE)
    return {ok: false, msg: `Tienes deuda en ${months.length} meses. Paga antes de crear nuevos días.`};
  
  return {ok: true};
}

/* ---------- MARK DAY WORKED ---------- */
async function markDayWorked(day,date=currentMonthDate){
  showLoader();
  const targetDate = new Date(date.getFullYear(), date.getMonth(), day);
  
  // Validación antes de crear
  const validation = await canCreateNewDay(targetDate);
  if(!validation.ok){
    document.getElementById('debt-block-msg').textContent = validation.msg;
    document.getElementById('debt-block-modal').classList.remove('hidden');
    hideLoader();
    return;
  }
  
  // Validar tarifa diaria
  const rate = safeParseFloat(document.getElementById('daily-rate').value);
  if(rate <= 0){
    document.getElementById('daily-rate-warning').classList.remove('hidden');
    hideLoader();
    showNotification('La tarifa diaria debe ser mayor a 0', 'warning');
    return;
  } else {
    document.getElementById('daily-rate-warning').classList.add('hidden');
  }
  
  const { days } = await readMonthDoc(targetDate);
  const k = String(day);

  if(days[k]?.created){ 
    showNotification('Ese día ya fue registrado','warning'); 
    hideLoader(); 
    return; 
  }

  let rec = { created:true, date:k, rate:+rate.toFixed(2), payment:0 };

  if(globalCredit > 0.01){
    const apply = Math.min(globalCredit, rec.rate);
    rec.payment = +apply.toFixed(2);
    globalCredit = +(globalCredit - apply).toFixed(2);
    await saveGlobalCredit();
    showNotification(`S/ ${apply.toFixed(2)} de crédito aplicado.`, 'info');
  }

  rec.status = determineStatus(rec);
  days[k] = rec;

  let req=0, paid=0;
  for(const kk in days){ const r = days[kk]; if(r?.created){ req += safeParseFloat(r.rate); paid += safeParseFloat(r.payment||0); } }
  const meta={ monthlyEndBalance:+(req-paid).toFixed(2), updatedAt:Date.now() };
  await writeMonthDoc(targetDate, days, meta);

  await loadInitial();
  hideLoader();
}

/* ---------- SAVE PAYMENT ---------- */
async function saveDayPayment(){
  showLoader();
  const amount = safeParseFloat(document.getElementById('payment-amount').value);
  if(amount<=0){ showNotification('Ingresa un monto mayor a 0','warning'); hideLoader(); return; }
  await applyPayment(amount);
  closePaymentModal();
  await loadInitial();
  hideLoader();
}

/* ---------- UPDATE SUMMARY ---------- */
async function updateSummary(){
  let totalDaysWorked=0, totalDaysPaid=0, totalPaid=0, totalRequired=0;
  for(const k in monthlyData){
    const r=monthlyData[k];
    if(!r?.created) continue;
    totalDaysWorked++; totalRequired+=safeParseFloat(r.rate); totalPaid+=safeParseFloat(r.payment||0);
    if(r.status==='paid') totalDaysPaid++;
  }
  
  // Calcular balance total sumando TODOS los meses con deuda
  const months = await collectMonthsWithDebt();
  const totalBalance = months.reduce((sum, m) => sum + m.debt, 0);
  
  document.getElementById('total-balance').textContent=`S/ ${totalBalance.toFixed(2)}`;
  document.getElementById('days-summary').textContent=`${totalDaysWorked} / ${totalDaysPaid}`;
  
  if(totalDaysWorked>0 && Math.abs(totalBalance)<0.01) {
    document.getElementById('fully-paid-modal').classList.remove('hidden');
  }
}

/* ---------- RESET ---------- */
async function resetAllData(){
  const PASSWORD="mi-reset-super-secreto";
  const ask=prompt("Introduce la contraseña para resetear TODO:");
  if(ask!==PASSWORD){ alert('Contraseña incorrecta'); return; }
  showLoader();
  const today=new Date(); const promises=[];
  for(let i=0;i<MONTHS_TO_VIEW;i++){
    const d=new Date(today.getFullYear(),today.getMonth()-i,1);
    promises.push(setDoc(doc(db,monthDocPath(d)),{ days:{}, meta:{ monthlyEndBalance:0, updatedAt:Date.now() } },{merge:true}));
  }
  await Promise.all(promises); globalCredit=0; await saveGlobalCredit();
  showNotification('Datos reiniciados','warning');
  await loadInitial();
  hideLoader();
}

/* ---------- INITIAL LOAD ---------- */
async function loadInitial(){
  showLoader();
  const { days, meta } = await readMonthDoc(currentMonthDate);
  monthlyData = days;
  await loadPriorMonthDebt();
  await loadGlobalCredit();
  await checkAuditMode();
  renderCalendar();
  await updateSummary();
  updateNavigationButtons();
  hideLoader();
}

/* ---------- EVENT BINDINGS ---------- */
window.addEventListener('load',async()=>{
  document.getElementById('prev-month-btn').addEventListener('click',async()=>{ currentMonthDate.setMonth(currentMonthDate.getMonth()-1); await loadInitial(); });
  document.getElementById('next-month-btn').addEventListener('click',async()=>{ currentMonthDate.setMonth(currentMonthDate.getMonth()+1); await loadInitial(); });
  document.getElementById('work-modal-cancel-btn').addEventListener('click',()=>document.getElementById('work-confirmation-modal').classList.add('hidden'));
  document.getElementById('work-modal-confirm-btn').addEventListener('click',async()=>{ if(selectedDayInfo) await markDayWorked(selectedDayInfo.day, selectedDayInfo.date||currentMonthDate); document.getElementById('work-confirmation-modal').classList.add('hidden'); });
  document.getElementById('modal-cancel-btn').addEventListener('click',closePaymentModal);
  document.getElementById('modal-save-btn').addEventListener('click',saveDayPayment);
  document.getElementById('paid-modal-close-btn').addEventListener('click',()=>document.getElementById('fully-paid-modal').classList.add('hidden'));
  document.getElementById('reset-btn').addEventListener('click',resetAllData);

  await loadInitial();
});
