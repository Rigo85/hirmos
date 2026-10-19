import {expect,test,type Page,type BrowserContext} from '@playwright/test';

test.skip(process.env.HIRMOS_TRACK_LAYOUT_LAB!=='1','Requires synthetic --track-layout fixture');
let cookies:Awaited<ReturnType<BrowserContext['cookies']>>;
test.beforeAll(async({request})=>{
  if(process.env.HIRMOS_E2E_ORIGIN!=='http://127.0.0.1:3313')throw Error('Loopback fixture required');
  const response=await request.post('/api/auth/login',{data:{email:'listener@example.test',password:'Fixture-only-2026!'}});
  expect(response.ok()).toBe(true);cookies=(await request.storageState()).cookies;
});
async function home(page:Page){
  await page.context().addCookies(cookies);await page.goto('/');
  await expect(page.locator('.track-carousel .track-row')).toHaveCount(4);
  await expect(page.locator('.track-carousel .track-row__title').first()).toContainText('Walk In The Shadows');
}
async function album(page:Page){
  const href=await page.locator('.track-carousel .track-row__album-name').first().getAttribute('href');
  await page.goto(href!);await expect(page.locator('.detail-tracks .track-row')).toHaveCount(4);
}
async function assertRows(page:Page,selector:string,minTitleWidth:number){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  for(const row of await page.locator(selector).all()){
    // One layout snapshot: notifications/scroll anchoring can move the whole
    // row between separate protocol calls without its children overlapping.
    const {title,footer,bounds}=await row.evaluate(element=>({
      title:element.querySelector('.track-row__title')!.getBoundingClientRect().toJSON(),
      footer:element.querySelector('.track-row__trailing')!.getBoundingClientRect().toJSON(),
      bounds:element.getBoundingClientRect().toJSON(),
    }));
    expect(title!.width).toBeGreaterThanOrEqual(minTitleWidth);
    const compact=await row.evaluate(e=>e.classList.contains('track-row--album'));
    if(compact){
      expect(footer.x).toBeGreaterThanOrEqual(title.x+title.width);
      await expect(row.locator('.track-row__favorite')).toBeHidden();
      await expect(row.locator('.track-row__compact-status time')).toHaveText('3:00');
    }else expect(footer!.y).toBeGreaterThanOrEqual(title!.y+title!.height-1);
    expect(footer!.x+footer!.width).toBeLessThanOrEqual(bounds!.x+bounds!.width+1);
    for(const button of await row.locator('.track-row__trailing button:visible').all()){
      const b=await button.boundingBox();expect(b!.width).toBeGreaterThanOrEqual(44);expect(b!.height).toBeGreaterThanOrEqual(44);
    }
  }
}

test.describe('mobile',()=>{
  test.use({isMobile:true,hasTouch:true});
  for(const width of [320,360,390,412])test(`readable recent cards and album rows at ${width}`,async({page})=>{
    await page.setViewportSize({width,height:900});await home(page);
    await assertRows(page,'.track-carousel .track-row',170);
    await expect(page.locator('.track-carousel .track-cover-control app-icon').first()).toHaveCSS('opacity','1');
    await page.screenshot({path:`/tmp/hirmos-recent-${width}.png`,fullPage:true});
    const title=await page.locator('.track-carousel .track-row__title').first().textContent();
    await page.locator('.track-carousel .track-row__playlist').first().click();
    await expect(page.locator('dialog[open] .track-identity strong')).toHaveText(title!);
    await page.locator('dialog[open]').getByRole('button',{name:'Cerrar',exact:true}).click();
    await album(page);await assertRows(page,'.detail-tracks .track-row',170);
    await expect(page.locator('.detail-tracks .track-row__artist').first()).toBeHidden();
    await expect(page.locator('.detail-tracks .track-row__album-name').first()).toBeHidden();
    await expect(page.locator('.detail-tracks .track-row__artist').nth(2)).toBeVisible();
    await expect(page.locator('.detail-tracks .track-row__album-name').nth(2)).toBeHidden();
    await page.screenshot({path:`/tmp/hirmos-tracks-${width}.png`,fullPage:true});
    if(width===360){
      const row=page.locator('.detail-tracks .track-row').first();
      await row.locator('.track-row__play').click();await expect(row).toHaveClass(/track-row--playing/);
      await row.locator('.track-row__play').click();await expect(row).not.toHaveClass(/track-row--playing/);
      await row.locator('.track-row__playlist').click();
      const favorite=page.locator('dialog[open]').getByRole('button',{name:/^(Añadir a|Quitar de) favoritos$/});
      const pressed=await favorite.getAttribute('aria-pressed');await favorite.click();
      await expect(favorite).toHaveAttribute('aria-pressed',pressed==='true'?'false':'true');
      await expect(row).not.toHaveClass(/track-row--playing/);
      await page.locator('dialog[open]').getByRole('button',{name:'Cerrar',exact:true}).click();
    }
  });
  test('enlarged text and downloaded state do not overlap or displace actions',async({page})=>{
    await page.setViewportSize({width:320,height:1000});await home(page);await album(page);
    const row=page.locator('.detail-tracks .track-row').first();
    const before=await row.locator('.track-row__playlist').boundingBox();
    await page.locator('app-download-button button').click();
    await expect(page.locator('app-download-button a.outline-button')).toHaveText('Descargado',{timeout:30000});
    await expect(row.locator('.track-row__compact-status [aria-label="Descargada en este navegador"]')).toBeVisible();
    const after=await row.locator('.track-row__playlist').boundingBox();expect(after!.x).toBe(before!.x);
    await page.addStyleTag({content:':root{font-size:30px!important}'});
    await assertRows(page,'.detail-tracks .track-row',170);
    await page.screenshot({path:'/tmp/hirmos-tracks-enlarged.png',fullPage:true});
    await page.goto('/');await expect(page.locator('.track-carousel .track-row')).toHaveCount(4);
    await page.addStyleTag({content:':root{font-size:30px!important}'});
    await assertRows(page,'.track-carousel .track-row',170);
    await page.screenshot({path:'/tmp/hirmos-recent-enlarged.png',fullPage:true});
  });
});

test('desktop album retains its existing layout and complete metadata',async({page})=>{
  await page.setViewportSize({width:1280,height:900});await home(page);
  await page.screenshot({path:'/tmp/hirmos-recent-desktop.png',fullPage:true});
  await album(page);
  const row=page.locator('.detail-tracks .track-row').first();
  await expect(row.locator('.track-row__artist')).toBeVisible();
  await expect(row.locator('.track-row__album-name')).toBeVisible();
  await expect(row.locator('.track-row__title')).toHaveCSS('white-space','nowrap');
  await expect(row.locator('.track-row__favorite')).toBeVisible();
  await expect(row.locator('.track-row__compact-status')).toBeHidden();
  await expect(page.locator('.player-bar')).toHaveCSS('height','76px');
});
