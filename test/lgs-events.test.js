import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleApi } from '../src/api.js';
import { sha256 } from '../src/utils.js';
async function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  db.exec(`INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ('u','user@example.com','hash','2020','2020'), ('other','other@example.com','hash','2020','2020');
    INSERT INTO lgs_stores (id,store_key,store_url,adapter,title,created_at,updated_at,last_checked_at) VALUES ('store','riftbound:store','https://locator.riftbound.uvsgames.com/stores/e00badc3-12ff-4857-856e-d870a856bdf4','riftbound-store','Test Store','2020','2020','2026-10-01');
    INSERT INTO lgs_subscriptions (id,user_id,store_id,created_at,updated_at,initialized_at) VALUES ('sub','u','store','2020','2020','2020');
    INSERT INTO lgs_subscription_events (subscription_id,event_key,event_url,title,first_seen_at) VALUES ('sub','123','https://locator.riftbound.uvsgames.com/events/123','Saved Event','2020');`);
  db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run('session','u',await sha256('token'),'2099','2020');
  const env = { DB: { prepare(sql) { const statement=db.prepare(sql);let args=[];return { bind(...a) { args=a;return this; }, async first() {return statement.get(...args)||null;}, async all(){return {results:statement.all(...args)};}, async run(){return {meta:{changes:statement.run(...args).changes}};} }; } } };
  return { db, env, request: () => new Request('https://event-watch.example/api/lgs/store/events', {headers:{cookie:'eventwatch_session=token'}}) };
}
test('returns every currently listed event, including untracked events, without changing alert baseline', async t => {
  const { db, env, request } = await fixture();
  t.mock.method(globalThis,'fetch',async()=>new Response('<html><body><h1>Test Store</h1><a href="/events/456">New Tournament</a><a href="/events/789">Weekly Play</a><a href="/events/456">Duplicate</a></body></html>'));
  const data = await (await handleApi(request(),env)).json();
  assert.equal(data.source,'live');assert.equal(data.events.length,2);assert.equal(data.events[0].title,'New Tournament');
  assert.deepEqual(data.events.map(e=>e.event_key),['456','789']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM lgs_subscription_events').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM alert_queue').get().n,0);db.close();
});
test('source failure returns saved events with explicit warning', async t => {
  const {db,env,request}=await fixture();t.mock.method(globalThis,'fetch',async()=>new Response('',{status:503}));
  const data=await (await handleApi(request(),env)).json();assert.equal(data.source,'saved');assert.equal(data.events[0].title,'Saved Event');assert.ok(data.warning);assert.equal(data.fetchedAt,'2026-10-01');db.close();
});
test('archived LGS details can display current events and an empty list', async t=> {
  const {db,env,request}=await fixture();db.exec("UPDATE lgs_subscriptions SET active=0");t.mock.method(globalThis,'fetch',async()=>new Response('<html><body><h1>Store</h1><p>No upcoming events at this store. Please check back later for new announcements.</p></body></html>'));
  const data=await (await handleApi(request(),env)).json();assert.equal(data.source,'live');assert.deepEqual(data.events,[]);db.close();
});
test('event listing requires login and ownership before requesting the source', async t=>{
  const {db,env,request}=await fixture();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('');});
  await assert.rejects(handleApi(new Request('https://event-watch.example/api/lgs/store/events'),env),e=>e.status===401);
  db.exec("UPDATE sessions SET user_id='other'");await assert.rejects(handleApi(request(),env),e=>e.status===404);assert.equal(calls,0);db.close();
});

test('unwatched LGS event opens internal details without creating a watch', async t => {
  const { db, env } = await fixture();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html><h1>Saved Event</h1><button>Log In to Join</button><p>Event registration is available. Welcome to this event.</p></html>'));
  const request = new Request('https://event-watch.example/api/lgs/store/events/123', { headers: { cookie: 'eventwatch_session=token' } });
  const data = await (await handleApi(request, env)).json();
  assert.equal(data.event.is_watched, false);assert.equal(data.event.status, 'AVAILABLE');
  assert.equal(data.event.event_url, 'https://locator.riftbound.uvsgames.com/events/123');
  assert.equal(db.prepare('SELECT count(*) AS n FROM subscriptions').get().n, 0);db.close();
});
test('internal event details reject events outside the owned LGS listing', async t => {
  const {db,env}=await fixture();
  t.mock.method(globalThis,'fetch',async()=>new Response('<html><h1>Store</h1><p>No events listed at this store. Check back for upcoming event announcements later.</p></html>'));
  await assert.rejects(handleApi(new Request('https://event-watch.example/api/lgs/store/events/999', {headers:{cookie:'eventwatch_session=token'}}), env), e=>e.status===404);db.close();
});
