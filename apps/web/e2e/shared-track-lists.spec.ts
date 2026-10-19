import {expect,test,type BrowserContext,type Page} from '@playwright/test';
import type {AlbumDetail,Track} from '@hirmos/contracts';

test.skip(!process.env.HIRMOS_FIXTURE_CATALOG_FILE,'Requires the private loopback catalog lab');
let cookies:Awaited<ReturnType<BrowserContext['cookies']>>;
let tracks:Track[],artistId:string;
test.beforeAll(async({request})=>{
  if(process.env.HIRMOS_E2E_ORIGIN!=='http://127.0.0.1:3313')throw Error('Loopback fixture required');
  const response=await request.post('/api/auth/login',{data:{email:'listener@example.test',password:'Fixture-only-2026!'}});
  expect(response.status()).toBe(200);cookies=(await request.storageState()).cookies;
  const albums=(await (await request.get('/api/library/albums?limit=50')).json()).albums;
  const details:AlbumDetail[]=await Promise.all(albums.slice(0,4).map(async(a:{id:string})=>(await request.get(`/api/library/albums/${a.id}`)).json()));
  tracks=details.flatMap(a=>a.tracks.slice(0,4));artistId=details.find(a=>a.tracks.length>5)!.artistId!;
  expect(tracks.length).toBeGreaterThan(5);
});

async function checkRows(page:Page,mobile:boolean){
  const rows=page.locator('li.track-row');await expect(rows.first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  for(const row of (await rows.all()).slice(0,8)){
    await expect(row).toHaveClass(/track-row--compact/);
    await expect(row.locator('.track-row__artist')).toBeVisible();
    await expect(row.locator('.track-row__album-name')).toBeVisible();
    await expect(row.locator('.track-row__favorite'))[mobile?'toBeHidden':'toBeVisible']();
    // Search intentionally has no duration; an empty status takes no height.
    await expect(row.locator('.track-row__compact-status')).toHaveCSS('display',mobile?'flex':'none');
    await expect(row.locator('.track-row__title')).toHaveCSS('white-space',mobile?'normal':'nowrap');
    const boxes=await row.evaluate(e=>{
      const box=(s:string)=>e.querySelector(s)!.getBoundingClientRect().toJSON();
      return {title:box('.track-row__title'),menu:box('.track-row__playlist'),row:e.getBoundingClientRect().toJSON()};
    });
    if(mobile){
      expect(boxes.title.width).toBeGreaterThanOrEqual(140);
      expect(boxes.menu.width).toBe(44);expect(boxes.menu.height).toBe(44);
      expect(boxes.title.right).toBeLessThanOrEqual(boxes.menu.x);
      await expect(row.locator('.track-row__separator')).toBeHidden();
    }
    expect(boxes.menu.right).toBeLessThanOrEqual(boxes.row.right);
  }
  await expect(page.locator('.player-bar')).toHaveCSS('height',mobile?'72px':'76px');
}

for(const width of [320,360,390,412,1077,1280])test(`shared music lists at ${width}`,async({page})=>{
  const mobile=width<761;await page.setViewportSize({width,height:900});await page.context().addCookies(cookies);
  // Only display data for views without meaningful synthetic listening history.
  // No imported history, production connection or fabricated backend listens.
  await page.route('**/api/library/activity/*',r=>r.fulfill({json:{tracks,nextCursor:null}}));
  await page.route('**/api/library/habits?*',r=>r.fulfill({json:{artists:[],albums:[],tracks:tracks.map(t=>({...t,listenedMs:445500000,qualifiedPlays:987,playStarts:987,estimated:false,importedPlays:0})),dataSince:null,nextCursor:null}}));
  await page.route('**/api/library/genres/Layout?*',r=>r.fulfill({json:{genre:'Layout',albums:[],tracks}}));
  const external:string[]=[];
  page.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.hostname!=='127.0.0.1')external.push(u.origin);});

  await page.goto(`/artists/${artistId}`);await checkRows(page,mobile);
  const popular=page.locator('#artist-popular-tracks');
  await expect(popular).toHaveCSS('overflow-y','auto');
  expect(await popular.evaluate(e=>e.scrollHeight)).toBeGreaterThan(await popular.evaluate(e=>e.clientHeight));
  await page.screenshot({path:`/tmp/hirmos-popular-${width}.png`,animations:'disabled'});
  const last=popular.locator('.track-row').last();await last.scrollIntoViewIfNeeded();await expect(last).toBeInViewport();
  if(width===360){
    await last.locator('.track-row__play').click();await expect(last).toHaveClass(/track-row--playing/);
    await last.locator('.track-row__play').click();await expect(last).not.toHaveClass(/track-row--playing/);
    const link=last.locator('.track-row__album-name');const href=await link.getAttribute('href');
    await link.click();await expect(page).toHaveURL(new RegExp(href!));
    await expect(page.locator('.detail-tracks .track-row--playing')).toHaveCount(0);
  }
  for(const path of ['/library','/search?q=prueba','/activity/recent','/activity/most-played','/habits','/genres/Layout']){
    await page.goto(path);
    if(path==='/library'||path==='/habits')await page.locator('.library-tabs').getByRole('button',{name:/^Canciones/}).click();
    await checkRows(page,mobile);
    if(path.startsWith('/search'))await expect(page.locator('.track-row__compact-status time')).toHaveCount(0);
    if(path==='/habits'){
      await expect(page.locator('.track-row__metric').first()).toContainText('987 escuchas');
      if(mobile)await expect(page.locator('.track-row__metric').first()).toBeVisible();
    }
  }
  const target=tracks[0]!;
  expect((await page.request.put(`/api/library/tracks/${target.id}/favorite`,{data:{favorite:true}})).ok()).toBe(true);
  await page.goto('/favorites');await checkRows(page,mobile);
  const actions=await page.locator('.favorites-page .genre-actions').boundingBox();
  const downloadNote=await page.locator('.favorites-download-note').boundingBox();
  expect(actions).not.toBeNull();expect(downloadNote).not.toBeNull();
  expect(downloadNote!.y-(actions!.y+actions!.height)).toBeCloseTo(16,0);
  await page.screenshot({path:`/tmp/hirmos-favorites-spacing-${width}.png`,animations:'disabled'});
  const row=page.locator('.track-row').filter({has:page.getByRole('button',{name:`Opciones para ${target.title}`,exact:true})});
  if(mobile){
    await row.locator('.track-row__playlist').click();
    await page.locator('dialog[open]').getByRole('button',{name:'Quitar de favoritos',exact:true}).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator('app-queue-actions dialog[open]')).toHaveCount(0);
  }else{await row.locator('.track-row__favorite').click();await expect(row).toHaveCount(0);}
  if(width===320){
    await page.goto(`/artists/${artistId}`);
    await page.addStyleTag({content:':root{font-size:30px!important}'});
    await checkRows(page,true);
    await page.screenshot({path:'/tmp/hirmos-popular-enlarged.png',animations:'disabled'});
  }
  expect(external).toEqual([]);
});

test('popular tracks from multiple albums retain distinct album navigation',async({page})=>{
  await page.setViewportSize({width:360,height:900});await page.context().addCookies(cookies);
  const response=await page.request.get('/api/library/artists?limit=50');expect(response.ok()).toBe(true);
  const artist=(await response.json()).artists.find((a:{albumCount:number})=>a.albumCount>1);
  expect(artist).toBeTruthy();
  await page.goto(`/artists/${artist.id}`);await checkRows(page,true);
  const links=page.locator('#artist-popular-tracks .track-row__album-name');
  const hrefs=await links.evaluateAll(elements=>[...new Set(elements.map(e=>e.getAttribute('href')))]);
  expect(hrefs.length).toBeGreaterThan(1);
  await page.screenshot({path:'/tmp/hirmos-popular-multiple-albums.png',animations:'disabled'});
  for(const href of hrefs){
    await page.goto(`/artists/${artist.id}`);
    const link=page.locator('#artist-popular-tracks .track-row__album-name').filter({visible:true});
    const target=link.locator(`xpath=self::*[@href="${href}"]`).first();
    const title=await target.textContent();await target.click();
    await expect(page.locator('app-album h1')).toHaveText(title!);
  }
});
