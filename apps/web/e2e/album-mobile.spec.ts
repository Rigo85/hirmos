import {expect, test, type BrowserContext, type Page} from '@playwright/test';

// Explicit opt-in: this suite signs into the disposable loopback fixture only.
test.skip(process.env.HIRMOS_ALBUM_LAYOUT_LAB !== '1', 'Requires the synthetic album layout lab');

let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;

test.beforeAll(async({request})=>{
  const origin=process.env.HIRMOS_E2E_ORIGIN ?? '';
  if(new URL(origin).hostname !== '127.0.0.1' || new URL(origin).port !== '3313')throw new Error('Loopback fixture required');
  const response=await request.post(`${origin}/api/auth/login`, {data:{email:'listener@example.test',password:'Fixture-only-2026!'}});
  expect(response.status()).toBe(200);
  cookies=(await request.storageState()).cookies;
});

async function albumPage(page: Page) {
  await page.context().addCookies(cookies);
  await page.goto('/library');
  const card=page.locator('a[href^="/albums/"]').first();
  await expect(card).toBeVisible();
  const href=await card.getAttribute('href');
  await page.goto(href!);
  await expect(page.locator('app-album h1')).toHaveText('Prueba de continuidad');
}

async function boxes(page: Page) {
  return page.locator('.album-actions').evaluate(root=>{
    const controls=[...root.querySelectorAll(':scope > button, app-download-button > button, app-download-button > a.outline-button')];
    return controls.map(element=>{const box=element.getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,scroll:element.scrollWidth,client:element.clientWidth};});
  });
}

for(const width of [320,360,390]) {
  test(`mobile album actions align at ${width}px, including download completion`,async({page})=>{
    await page.setViewportSize({width,height:900});await albumPage(page);
    const controls=await boxes(page);expect(controls).toHaveLength(3);
    for(const box of controls){expect(box.y).toBeCloseTo(controls[0]!.y,0);expect(box.height).toBeCloseTo(controls[0]!.height,0);expect(box.height).toBeGreaterThanOrEqual(48);expect(box.scroll).toBeLessThanOrEqual(box.client+1);}
    // The existing global search bar overflows below 371px; this scoped change
    // must keep the album header/actions within the viewport without hiding it.
    for(const selector of ['.detail-hero','.album-actions-zone']) {
      const bounds=await page.locator(selector).boundingBox();
      expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.locator(selector).evaluate(e=>e.scrollWidth)).toBeLessThanOrEqual(bounds!.width+1);
    }
    const cover=await page.locator('.detail-cover').boundingBox();
    const info=await page.locator('.album-info').boundingBox();expect(cover!.y).toBeCloseTo(info!.y,0);
    const primary=await page.locator('.album-playback-actions').boundingBox();
    expect(primary!.y).toBeGreaterThanOrEqual(Math.max(cover!.y+cover!.height,info!.y+info!.height));
    expect(await page.locator('.album-actions > button').first().innerText()).toBe('Añadir a playlist');
    await page.screenshot({path:`/tmp/hirmos-album-mobile-${width}.png`,fullPage:true});
    await page.locator('app-download-button button').click();
    await expect(page.locator('app-download-button a.outline-button')).toHaveText('Descargado',{timeout:30000});
    const complete=await boxes(page);for(const box of complete)expect(box.y).toBeCloseTo(complete[0]!.y,0);
    // Check presentation of longer labels and auxiliary messages separately from
    // the real transfer above. State transitions are covered by component tests.
    await page.locator('app-download-button').evaluate(host=>{
      host.querySelector('a.outline-button span')!.textContent='Completar descarga';
      const status=document.createElement('span');status.role='status';status.textContent='Ver descargas';host.append(status);
      const error=document.createElement('p');error.className='form-error';error.role='alert';error.textContent='No pudimos preparar la descarga. Inténtalo de nuevo.';host.append(error);
      // Match Angular's scoped styling on these presentation-only fixtures.
      const scope=host.querySelector('a.outline-button')!.getAttributeNames().find(name=>name.startsWith('_ngcontent-'))!;
      status.setAttribute(scope,'');error.setAttribute(scope,'');
    });
    const longer=await boxes(page);for(const box of longer){expect(box.y).toBeCloseTo(longer[0]!.y,0);expect(box.height).toBeCloseTo(longer[0]!.height,0);expect(box.scroll).toBeLessThanOrEqual(box.client+1);}
    const feedback=await page.locator('app-download-button > [role=status]').boundingBox();
    expect(feedback!.y).toBeGreaterThanOrEqual(longer[0]!.y+longer[0]!.height);
    const alert=await page.locator('app-download-button > [role=alert]').boundingBox();
    expect(alert!.y).toBeGreaterThanOrEqual(feedback!.y+feedback!.height);
    await page.screenshot({path:`/tmp/hirmos-album-mobile-${width}-feedback.png`,fullPage:true});
  });
}

test('enlarged text stacks management actions without truncation',async({page})=>{
  await page.setViewportSize({width:320,height:1000});await albumPage(page);
  await page.addStyleTag({content:':root {font-size:30px !important}'});
  const controls=await boxes(page);
  expect(controls[1]!.y).toBeGreaterThan(controls[0]!.y+controls[0]!.height);
  expect(controls[2]!.y).toBeGreaterThan(controls[1]!.y+controls[1]!.height);
  for(const box of controls)expect(box.scroll).toBeLessThanOrEqual(box.client+1);
  for(const button of await page.locator('.album-playback-actions button').all()) {
    expect(await button.evaluate(e=>e.scrollWidth)).toBeLessThanOrEqual(await button.evaluate(e=>e.clientWidth+1));
  }
  await page.screenshot({path:'/tmp/hirmos-album-mobile-enlarged.png',fullPage:true});
});

for(const width of [1077,1280])for(const collapsed of [false,true])test(`desktop actions align at ${width}px with sidebar ${collapsed?'collapsed':'expanded'}`,async({page})=>{
  await page.setViewportSize({width,height:900});await albumPage(page);
  if(collapsed)await page.getByRole('button',{name:'Contraer menú lateral'}).click();
  await expect(page.locator('.album-info')).toHaveCSS('display','contents');
  await expect(page.locator('.album-copy')).toHaveCSS('display','block');
  await expect(page.locator('.album-playback-actions')).toHaveCSS('display','flex');
  await expect(page.getByRole('button',{name:'Reproducir álbum',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Añadir álbum a playlist',exact:true})).toBeVisible();
  await expect(page.locator('.player-bar')).toHaveCSS('height','76px');
  async function assertAlignment(){
    const controls=await boxes(page);expect(controls).toHaveLength(3);
    for(const [i,box] of controls.entries()){
      expect(box.y).toBeCloseTo(controls[0]!.y,0);
      expect(box.height).toBe(44);
      if(i)expect(box.x-controls[i-1]!.x-controls[i-1]!.width).toBeCloseTo(12,0);
    }
    const contents=await page.locator('.album-actions').evaluate(root=>
      [...root.querySelectorAll(':scope > button, app-download-button > button, app-download-button > a.outline-button')].map(button=>{
        const icon=button.querySelector('app-icon')!.getBoundingClientRect();
        const label=[...button.querySelectorAll('span')].find(span=>getComputedStyle(span).display!=='none')!.getBoundingClientRect();
        return{gap:label.x-icon.right,center:Math.abs(icon.y+icon.height/2-label.y-label.height/2)};
      }));
    for(const item of contents){expect(item.gap).toBeCloseTo(8,0);expect(item.center).toBeLessThanOrEqual(1);}
  }
  await assertAlignment();
  await page.screenshot({path:`/tmp/hirmos-album-desktop-${width}-${collapsed?'collapsed':'expanded'}.png`,fullPage:true});
  await page.locator('app-download-button button').click();
  await expect(page.locator('app-download-button a.outline-button')).toHaveText('Descargado',{timeout:30000});
  await assertAlignment();
  // Layout-only simulation of a longer state and feedback, not a failed transfer.
  await page.locator('app-download-button').evaluate(host=>{
    const button=host.querySelector('a.outline-button')!;
    button.querySelector('span')!.textContent='Completar descarga';
    const error=document.createElement('p');error.role='alert';error.className='form-error';
    error.textContent='No pudimos preparar la descarga. Inténtalo de nuevo.';
    error.setAttribute(button.getAttributeNames().find(name=>name.startsWith('_ngcontent-'))!,'');host.append(error);
  });
  await assertAlignment();
  const feedback=await page.locator('app-download-button > [role=alert]').boundingBox();
  const controls=await boxes(page);
  expect(feedback!.y).toBeGreaterThanOrEqual(controls[0]!.y+controls[0]!.height+12);
});
