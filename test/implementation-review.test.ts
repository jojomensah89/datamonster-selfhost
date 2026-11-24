import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import app from '../src/worker/index';
import { forgetAllSites, type Env, type Site } from '../src/worker/env';
import { createSession } from '../src/worker/auth';
import { createToken } from '../src/agent/tokens';
import { recordPayment } from '../src/worker/payments';
import { guideFor } from '../src/agent/guide';
import { customers, visitors, type Ctx } from '../src/worker/stats';
import { makeD1 } from './helpers/d1';
function setup(hosted = false) {
 const db = makeD1(); forgetAllSites();
 db.raw.exec("INSERT INTO users (id,email,created_at,plan_status,plan_until) VALUES ('a','a@example.com',0,'active',9999999999999),('b','b@example.com',0,'expired',0); INSERT INTO sites (id,name,domain,timezone,currency,api_key,created_at,owner_id) VALUES ('siteaaaa','A','example.com','UTC','USD','keya',0,'a'),('sitebbbb','B','b.example.com','UTC','USD','keyb',0,'b')");
 const env = { DB: db.d1, SESSION_SECRET: 'secret', ADMIN_PASSWORD: 'pw', ...(hosted ? { GOOGLE_CLIENT_ID:'id', GOOGLE_CLIENT_SECRET:'secret' } : {}) } as Env;
 const request = async (path: string, init: RequestInit = {}, user = hosted ? 'u:a' : 'admin') => app.request('https://dm.test'+path, {...init, headers: {cookie: 'dm_auth='+await createSession(env, user), ...init.headers}}, env, {waitUntil() {}} as any);
 return { db, env, request };
}
it('counts tracking after dashboard use from the same IP and browser without owner receipts', async () => {
 const {db,request}=setup();
 const headers={'user-agent':'Mozilla/5.0 Chrome/129.0 Safari/537.36','cf-connecting-ip':'192.0.2.1'};
 const me=await request('/api/auth/me',{headers});
 expect(me.status).toBe(200);
 expect(await me.json()).toMatchObject({loggedIn:true});
 const r=await request('/api/event',{method:'POST',headers,body:JSON.stringify({w:'siteaaaa',t:'pageview',vid:'visitor1',sid:'session1',u:'https://example.com/'})});
 expect(r.status).toBe(202);
 expect(db.raw.prepare('SELECT COUNT(*) n FROM sessions').get()).toMatchObject({n:1});
 for (const path of ['/api/sites','/api/sites/siteaaaa','/api/sites/siteaaaa/overview']) {
   const response=await request(path);
   expect(response.status).toBe(200);
   expect(JSON.stringify(await response.json())).not.toContain('last_owner_hit_at');
 }
 expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name='owner_devices'").get()).toBeUndefined();
 expect(db.raw.prepare('PRAGMA table_info(sites)').all().map(row=>row.name)).not.toContain('last_owner_hit_at');
});
it('deletes site audit rows while preserving another site', async () => {
 const {db,request}=setup();
 for(const id of ['siteaaaa','sitebbbb']) db.raw.prepare("INSERT INTO agent_audit(owner_id,token_id,site_id,tool,write,ok,ts) VALUES ('a','t',?,'get_overview',0,1,0)").run(id);
 expect((await request('/api/sites/siteaaaa',{method:'DELETE'})).status).toBe(200);
 expect(db.raw.prepare('SELECT site_id FROM agent_audit').all()).toEqual([{site_id:'sitebbbb'}]);
});
it('namespaces Dodo and Stripe payment storage against cross-site collisions', async () => {
 const {db}=setup();
 for(const provider of ['dodo','stripe']) for(const id of ['siteaaaa','sitebbbb']) {
 const site=await db.d1.prepare('SELECT * FROM sites WHERE id=?').bind(id).first<Site>();
 await recordPayment(db.d1,site!,{id:provider+'-shared',provider,ts:1000,amount:100,currency:'USD',kind:'payment'});
 }
 expect(db.raw.prepare('SELECT id FROM payments ORDER BY id').all()).toEqual(['siteaaaa:dodo-shared','siteaaaa:stripe-shared','sitebbbb:dodo-shared','sitebbbb:stripe-shared'].map(id=>({id})));
});
it('a lapsed owner is on Free: their dashboard, agents and recording carry on; self-host is unaffected', async () => {
 const {db,request,env}=setup(true);
 db.raw.prepare("UPDATE users SET plan_until=? WHERE id='b'").run(Date.now()-86400000); forgetAllSites();
 expect((await request('/api/sites/sitebbbb/overview',{},'u:b')).status).toBe(200);
 const {secret}=await createToken(db.d1,'b',{name:'test'});
 expect((await request('/api/agent/v1/list_sites',{headers:{authorization:`Bearer ${secret}`}})).status).toBe(200);
 const r=await request('/api/event',{method:'POST',headers:{'user-agent':'Mozilla/5.0 Chrome/129.0 Safari/537.36'},body:JSON.stringify({w:'sitebbbb',t:'pageview',vid:'visitor1',sid:'session1',u:'https://b.example.com/'})});
 expect(r.status).toBe(202); expect(db.raw.prepare('SELECT COUNT(*) n FROM sessions').get()).toMatchObject({n:1});
 delete env.GOOGLE_CLIENT_ID; delete env.GOOGLE_CLIENT_SECRET;
 expect((await request('/api/sites/sitebbbb/overview',{},'admin')).status).toBe(200);
});
it('returns only owner sites and correct per-site session totals', async () => {
 const {db,request}=setup(true);
 db.raw.exec(`INSERT INTO sessions(site_id,id,visitor_id,started_at,last_seen_at,entry_page,exit_page,source,channel) VALUES ('siteaaaa','s','v',${Date.now()},${Date.now()},'/','/','Direct','Direct'),('sitebbbb','s','v',${Date.now()},${Date.now()},'/','/','Direct','Direct')`);
 const rows=await (await request('/api/sites')).json() as any[];
 expect(rows.map(r=>r.id)).toEqual(['siteaaaa']); expect(rows[0].visitors24h).toBe(1);
});
it('retains each customer payment currency and excludes foreign money from visitor sums', async () => {
 const {db}=setup();
 db.raw.exec("INSERT INTO visitors(site_id,id,first_seen) VALUES ('siteaaaa','v',0); INSERT INTO sessions(site_id,id,visitor_id,started_at,last_seen_at,entry_page,exit_page,source,channel) VALUES ('siteaaaa','s','v',1000,1000,'/','/','Direct','Direct'); INSERT INTO payments(id,site_id,provider,ts,amount,currency,visitor_id,session_id) VALUES ('usd','siteaaaa','api',1000,100,'USD','v','s'),('eur','siteaaaa','api',1000,900,'EUR','v','s')");
 const ctx={db:db.d1,site:{id:'siteaaaa',currency:'USD'},range:{from:0,to:2000,granularity:'day'},filters:{},offset:0} as Ctx;
 expect((await customers(ctx)).map((p:any)=>p.currency).sort()).toEqual(['EUR','USD']);
 expect((await visitors(ctx))[0]).toMatchObject({spent:100});
});
it('uses hosted wording consistently from the shared guide',()=>{
 expect(guideFor(true).start).toContain('DataMonster is revenue analytics. It records visits and payments for your websites');
 expect(guideFor(true).start).not.toContain('own Cloudflare account');
 expect(guideFor(false).start).toContain('own Cloudflare account');
});

it('a forged Stripe refund on B cannot replace A refund sharing its provider id', async () => {
 const {db,env}=setup();
 db.raw.exec("UPDATE sites SET stripe_webhook_secret='whsec_test'; INSERT INTO payments(id,site_id,provider,ts,amount,currency,customer_id) VALUES ('siteaaaa:pi_shared','siteaaaa','stripe',1,100,'USD','ca'),('sitebbbb:pi_shared','sitebbbb','stripe',1,200,'USD','cb'); INSERT INTO payments(id,site_id,provider,ts,amount,kind,currency) VALUES ('siteaaaa:ch_shared:refund','siteaaaa','stripe',2,-100,'refund','USD')");
 const body=JSON.stringify({type:'charge.refunded',data:{object:{id:'ch_shared',payment_intent:'pi_shared',amount_refunded:200,currency:'USD'}}});
 const t=String(Math.floor(Date.now()/1000));
 const sig=createHmac('sha256','whsec_test').update(`${t}.${body}`).digest('hex');
 const response=await app.request('https://dm.test/api/webhooks/stripe/sitebbbb',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},body},env);
 expect(response.status).toBe(200);
 expect(db.raw.prepare("SELECT site_id,amount FROM payments WHERE id='siteaaaa:ch_shared:refund'").get()).toMatchObject({site_id:'siteaaaa',amount:-100});
 expect(db.raw.prepare("SELECT site_id,amount FROM payments WHERE id='sitebbbb:ch_shared:refund'").get()).toMatchObject({site_id:'sitebbbb',amount:-200});
});
