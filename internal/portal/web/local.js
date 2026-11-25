'use strict';
(()=>{
let token='',profile=null,busy=false,epoch=0;
const $=id=>document.getElementById(id), auth=$('local-auth');
const orders=new Map(); // Unconfirmed orders belong to the character, not the short-lived token.
const money=n=>Number.isSafeInteger(n)?(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'未知';
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
    const message='会话已过期，请重新进入个人中心。';clearSession(message);throw Error(message);
  }
  if(!response.ok){const value=await response.json().catch(()=>({}));const e=Error(value.error||'请求失败');e.status=response.status;throw e;}
  return response.json();
}
function render(p){profile=p;$('local-member-login').hidden=!!p;$('account_name').textContent=p?p.nickname:'请进入个人中心';$('login_button').textContent=p?'退出':'进入个人中心';const rows=document.querySelectorAll('.user_info .info tbody tr');const values=p?[p.username+' / ID '+p.userId,String(p.level)+(p.stars?' · ★ '+p.stars:''),'未设置',p.region,p.premium?(p.premiumUntil?'至 '+new Date(p.premiumUntil).toLocaleString('zh-CN',{hour12:false}):'长期会员'):'未开通',money(p.goldMinor),money(p.silverMinor)]:['未登录','—','未设置','中国','—','—','—'];rows.forEach((row,i)=>{const b=row.querySelector('b');if(b)b.textContent=values[i];});$('local-refresh').disabled=!p||busy;if(!p)$('local-plans').replaceChildren();$('local-member-message').textContent=!p?'请先进入个人中心，登录后会显示金币余额和会员套餐。':pendingOrder()?'上一次购买尚未确认，请查询原单回执。':'';}
function plans(state){
  const pending=pendingOrder();$('local-plans').replaceChildren();
  for(const plan of state.plans){
    const card=document.createElement('article');card.className='local-plan';const title=document.createElement('h3');title.textContent=plan.name;const price=document.createElement('p');price.textContent=money(plan.priceGold)+' 金币 · 经验 +100%';
    const button=document.createElement('button');button.className='button small salat';
    const retry=pending?.planID===plan.id,short=state.balance.gold<plan.priceGold;
    button.textContent=retry?'确认原单回执':state.membership.permanent?'已有永久会员':short?'金币不足':state.membership.active?'购买并续期':'购买会员';
    button.disabled=busy||(!retry&&(!!pending||state.membership.permanent||short));
    button.onclick=()=>buy(plan.id,state);card.append(title,price,button);$('local-plans').append(card);
  }
}
async function refresh(){if(!token)return;const own=epoch;const [p,m]=await Promise.all([api('/api/profile'),api('/api/membership')]);if(own!==epoch)return;render(p);plans(m);return m;}
async function buy(planID,state){
  if(!token){requestLogin();return;}if(busy)return;
  const own=epoch,order=pendingOrder()||{planID,requestID:crypto.randomUUID()};if(order.planID!==planID)return;
  setOrder(order);busy=true;$('local-refresh').disabled=true;plans(state);$('local-member-message').textContent='正在确认购买…';
  try{
    const result=await api('/api/membership/purchase','POST',order);if(own!==epoch)return;
    setOrder(null);state=result;
    render({...profile,premium:result.membership.active,premiumUntil:result.membership.expiresAt?result.membership.expiresAt*1000:null,goldMinor:result.balance.gold,silverMinor:result.balance.silver});
    try{state=await refresh()||result;if(own===epoch)$('local-member-message').textContent=result.purchase?.replayed?'购买已处理，未重复扣款。':'购买成功，游戏内会员状态将自动刷新。';}
    catch{if(own===epoch)$('local-member-message').textContent='购买已保存，账户刷新暂不可用；请点“刷新账户”查看，不要重复购买。';}
  }catch(e){
    if(own!==epoch)return;
    if(e.status===400)setOrder(null);
    $('local-member-message').textContent=e.message+(pendingOrder()?'；请确认原单回执。':'');
    try{state=await api('/api/membership');}catch{}
  }finally{if(own===epoch){busy=false;$('local-refresh').disabled=false;plans(state);}}
}
function requestLogin(){if(token)return;$('local-auth-message').textContent='请进入当前设备角色的个人中心。';$('local-member-message').textContent='请先登录：登录后会显示会员套餐。';if(!auth.open)auth.showModal();}
$('local-member-login').onclick=requestLogin;
document.querySelector('#main_menu a[href="#local-member"]').addEventListener('click',e=>{if(!token){e.preventDefault();requestLogin();}});
$('local-login').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;try{if(!token){const d=await api('/api/session','POST',{});token=d.token;epoch++;}await refresh();if(token){auth.close();$('local-message').textContent='已进入当前设备角色。';}}catch(e){$('local-auth-message').textContent=e.message;if(token&&!profile)clearSession(e.message);}finally{button.disabled=false;}};
$('login_button').onclick=async()=>{if(!token){requestLogin();return;}const own=epoch;try{await api('/api/session','DELETE');if(own===epoch)clearSession('已退出个人中心。');}catch(e){if(own===epoch)$('local-message').textContent=e.message;}};
$('local-auth-close').onclick=()=>auth.close();$('local-refresh').onclick=()=>refresh().catch(e=>$('local-message').textContent=e.message);
$('close-banner').onclick=()=>document.getElementById('head_banner').hidden=true;
render(null);
})();
