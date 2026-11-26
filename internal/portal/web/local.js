'use strict';
(()=>{
let token='',profile=null,busy=false,epoch=0;
const $=id=>document.getElementById(id), auth=$('local-auth');
const orders=new Map(); // Unconfirmed orders belong to the character, not the short-lived token.
const money=n=>Number.isSafeInteger(n)?(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'Неизвестно';
function pendingOrder(){
  const uid=profile?.userId;
  if(!orders.has(uid))try{orders.set(uid,JSON.parse(sessionStorage.getItem('portal.order.'+uid)));}catch{}
  return orders.get(uid);
}
function setOrder(order){
  const uid=profile.userId,key='portal.order.'+uid;
  orders.set(uid,order);
  try{if(order)sessionStorage.setItem(key,JSON.stringify(order));else sessionStorage.removeItem(key);}catch{}
}
function clearSession(message){token='';epoch++;busy=false;render(null);$('local-message').textContent=message;}
async function api(path,method='GET',data){
  const own=epoch,headers={};if(token)headers.Authorization='Bearer '+token;
  if(data!==undefined)headers['Content-Type']='application/json';
  const response=await fetch('/portal'+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});
  if(response.status===401&&own===epoch&&token){
    const message='Сессия истекла, войдите в личный кабинет снова.';clearSession(message);throw Error(message);
  }
  if(!response.ok){const value=await response.json().catch(()=>({}));const e=Error(value.error||'Ошибка запроса');e.status=response.status;throw e;}
  return response.json();
}
function render(p){profile=p;$('local-member-login').hidden=!!p;$('account_name').textContent=p?p.nickname:'Войдите в личный кабинет';$('login_button').textContent=p?'Выйти':'Войти в личный кабинет';const rows=document.querySelectorAll('.user_info .info tbody tr');const values=p?[p.username+' / ID '+p.userId,String(p.level)+(p.stars?' · ★ '+p.stars:''),'Не задано',p.region,p.premium?(p.premiumUntil?'до '+new Date(p.premiumUntil).toLocaleString('zh-CN',{hour12:false}):'Долгосрочный премиум'):'Не подключён',money(p.goldMinor),money(p.silverMinor)]:['Не выполнен вход','—','Не задано','Россия','—','—','—'];rows.forEach((row,i)=>{const b=row.querySelector('b');if(b)b.textContent=values[i];});$('local-refresh').disabled=!p||busy;if(!p)$('local-plans').replaceChildren();$('local-member-message').textContent=!p?'Сначала войдите в личный кабинет — после входа появятся баланс золота и тарифы премиума.':pendingOrder()?'Предыдущая покупка ещё не подтверждена, проверьте квитанцию исходного заказа.':'';}
function plans(state){
  const pending=pendingOrder();$('local-plans').replaceChildren();
  for(const plan of state.plans){
    const card=document.createElement('article');card.className='local-plan';const title=document.createElement('h3');title.textContent=plan.name;const price=document.createElement('p');price.textContent=money(plan.priceGold)+' золота · опыт +100%';
    const button=document.createElement('button');button.className='button small salat';
    const retry=pending?.planID===plan.id,short=state.balance.gold<plan.priceGold;
    button.textContent=retry?'Проверить квитанцию заказа':state.membership.permanent?'Уже есть вечный премиум':short?'Недостаточно золота':state.membership.active?'Купить и продлить':'Купить премиум';
    button.disabled=busy||(!retry&&(!!pending||state.membership.permanent||short));
    button.onclick=()=>buy(plan.id,state);card.append(title,price,button);$('local-plans').append(card);
  }
}
async function refresh(){if(!token)return;const own=epoch;const [p,m]=await Promise.all([api('/api/profile'),api('/api/membership')]);if(own!==epoch)return;render(p);plans(m);return m;}
async function buy(planID,state){
  if(!token){requestLogin();return;}if(busy)return;
  const own=epoch,order=pendingOrder()||{planID,requestID:crypto.randomUUID()};if(order.planID!==planID)return;
  setOrder(order);busy=true;$('local-refresh').disabled=true;plans(state);$('local-member-message').textContent='Подтверждение покупки…';
  try{
    const result=await api('/api/membership/purchase','POST',order);if(own!==epoch)return;
    setOrder(null);state=result;
    render({...profile,premium:result.membership.active,premiumUntil:result.membership.expiresAt?result.membership.expiresAt*1000:null,goldMinor:result.balance.gold,silverMinor:result.balance.silver});
    try{state=await refresh()||result;if(own===epoch)$('local-member-message').textContent=result.purchase?.replayed?'Покупка уже обработана, повторного списания нет.':'Покупка успешна, статус премиума в игре обновится автоматически.';}
    catch{if(own===epoch)$('local-member-message').textContent='Покупка сохранена, но обновить аккаунт пока нельзя; нажмите «Обновить аккаунт» для проверки и не покупайте повторно.';}
  }catch(e){
    if(own!==epoch)return;
    if(e.status===400)setOrder(null);
    $('local-member-message').textContent=e.message+(pendingOrder()?'; проверьте квитанцию исходного заказа.':'');
    try{state=await api('/api/membership');}catch{}
  }finally{if(own===epoch){busy=false;$('local-refresh').disabled=false;plans(state);}}
}
function requestLogin(){if(token)return;$('local-auth-message').textContent='Войдите в личный кабинет персонажа этого устройства.';$('local-member-message').textContent='Сначала войдите: после входа появятся тарифы премиума.';if(!auth.open)auth.showModal();}
$('local-member-login').onclick=requestLogin;
document.querySelector('#main_menu a[href="#local-member"]').addEventListener('click',e=>{if(!token){e.preventDefault();requestLogin();}});
$('local-login').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;try{if(!token){const d=await api('/api/session','POST',{});token=d.token;epoch++;}await refresh();if(token){auth.close();$('local-message').textContent='Вы вошли в персонажа этого устройства.';}}catch(e){$('local-auth-message').textContent=e.message;if(token&&!profile)clearSession(e.message);}finally{button.disabled=false;}};
$('login_button').onclick=async()=>{if(!token){requestLogin();return;}const own=epoch;try{await api('/api/session','DELETE');if(own===epoch)clearSession('Вы вышли из личного кабинета.');}catch(e){if(own===epoch)$('local-message').textContent=e.message;}};
$('local-auth-close').onclick=()=>auth.close();$('local-refresh').onclick=()=>refresh().catch(e=>$('local-message').textContent=e.message);
$('close-banner').onclick=()=>document.getElementById('head_banner').hidden=true;
render(null);
})();
