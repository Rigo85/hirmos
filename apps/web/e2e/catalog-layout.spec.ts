import {expect,test,type BrowserContext} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test.skip(!process.env.HIRMOS_FIXTURE_CATALOG_FILE,'Requires the private snapshot fixture on loopback');
let cookies:Awaited<ReturnType<BrowserContext['cookies']>>;
let sample:{albums:{name:string;id:string}[];songs:{title:string;albumId:string;duration:number}[]};
test.beforeAll(async({request})=>{
  if(process.env.HIRMOS_E2E_ORIGIN!=='http://127.0.0.1:3313')throw Error('Loopback fixture required');
  sample=JSON.parse(await readFile(process.env.HIRMOS_FIXTURE_CATALOG_FILE!,'utf8'));
  const response=await request.post('/api/auth/login',{data:{email:'listener@example.test',password:'Fixture-only-2026!'}});
  expect(response.status()).toBe(200);cookies=(await request.storageState()).cookies;
});
test.use({isMobile:true,hasTouch:true});
for(const width of [320,360,390,412])test(`private catalog compact layout at ${width}`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.context().addCookies(cookies);
  const outside:string[]=[];
  page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.hostname!=='127.0.0.1')outside.push(url.origin);});
  for(const [index,album] of sample.albums.entries()){
    await page.goto('/library');
    await page.locator('a[href^="/albums/"]').filter({hasText:album.name}).first().click();
    const tracks=sample.songs.filter(t=>t.albumId===album.id);
    const rows=page.locator('.detail-tracks .track-row');await expect(rows).toHaveCount(tracks.length);
    await expect(page.locator('app-album h1')).toHaveText(album.name);
    await expect.poll(()=>page.locator('.detail-cover img,img.detail-cover').first().evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBeGreaterThan(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    for(const row of await rows.all()){
      const boxes=await row.evaluate(element=>{
        const title=element.querySelector('.track-row__title')!.getBoundingClientRect();
        const menu=element.querySelector('.track-row__playlist')!.getBoundingClientRect();
        return{width:title.width,right:title.right,menuX:menu.x,menuW:menu.width,menuH:menu.height,height:element.getBoundingClientRect().height};
      });
      expect(boxes.width).toBeGreaterThanOrEqual(170);expect(boxes.right).toBeLessThanOrEqual(boxes.menuX);
      expect(boxes.menuW).toBe(44);expect(boxes.menuH).toBe(44);expect(boxes.height).toBeLessThanOrEqual(105);
      await expect(row.locator('.track-row__favorite')).toBeHidden();
    }
    const first=rows.first(),seconds=Math.floor(tracks[0]!.duration);
    await expect(first.locator('.track-row__compact-status time')).toHaveText(`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`);
    if(width===360){
      await first.locator('.track-row__playlist').click();
      await expect(page.locator('dialog[open] .track-identity strong')).toHaveText(tracks[0]!.title);
      const favorite=page.locator('dialog[open]').getByRole('button',{name:/^(Añadir a|Quitar de) favoritos$/});
      const previous=await favorite.getAttribute('aria-pressed');await favorite.click();
      await expect(favorite).toHaveAttribute('aria-pressed',previous==='true'?'false':'true');
      await page.locator('dialog[open]').getByRole('button',{name:'Cerrar',exact:true}).click();
      await expect(first).not.toHaveClass(/track-row--playing/);
      await first.locator('.track-row__play').click();await expect(first).toHaveClass(/track-row--playing/);
      await first.locator('.track-row__play').click();await expect(first).not.toHaveClass(/track-row--playing/);
    }
    await page.screenshot({path:`/tmp/hirmos-catalog-${width}-${index}.png`,fullPage:true});
  }
  await page.goto('/');await expect(page.locator('.track-carousel .track-row')).toHaveCount(12);
  await page.screenshot({path:`/tmp/hirmos-catalog-home-${width}.png`,fullPage:true});
  expect(outside).toEqual([]);
});

test.describe('desktop regression',()=>{
  test.use({isMobile:false,hasTouch:false});
  for(const width of [1077,1280,1920])for(const collapsed of [false,true])
    test(`catalog desktop at ${width}, sidebar ${collapsed?'collapsed':'expanded'}`,async({page})=>{
      await page.setViewportSize({width,height:900});await page.context().addCookies(cookies);
      await page.goto('/');
      const collapse=page.getByRole('button',{name:'Contraer menú lateral',exact:true});
      if(collapsed)await collapse.click();
      for(const row of await page.locator('.track-carousel .track-row').all()){
        await expect(row.locator('.track-row__title')).toHaveCSS('white-space','nowrap');
        await expect(row.locator('.track-row__favorite')).toBeVisible();
      }
      for(const [index,album] of sample.albums.entries()){
        await page.goto('/library');
        await page.locator('a[href^="/albums/"]').filter({hasText:album.name}).first().click();
        const rows=page.locator('.detail-tracks .track-row');
        await expect(rows).toHaveCount(sample.songs.filter(t=>t.albumId===album.id).length);
        for(const row of await rows.all()){
          await expect(row.locator('.track-row__artist')).toBeVisible();
          await expect(row.locator('.track-row__album-name')).toBeVisible();
          await expect(row.locator('.track-row__favorite')).toBeVisible();
          await expect(row.locator('.track-row__compact-status')).toBeHidden();
          await expect(row.locator('.track-row__title')).toHaveCSS('white-space','nowrap');
          const boxes=await row.evaluate(e=>({
            copy:e.querySelector('.track-row__copy')!.getBoundingClientRect().toJSON(),
            trailing:e.querySelector('.track-row__trailing')!.getBoundingClientRect().toJSON(),
            row:e.getBoundingClientRect().toJSON(),
          }));
          expect(boxes.copy.width).toBeGreaterThan(200);
          expect(boxes.copy.right).toBeLessThanOrEqual(boxes.trailing.x);
          expect(boxes.trailing.right).toBeLessThanOrEqual(boxes.row.right);
        }
        await expect(page.locator('.player-bar')).toHaveCSS('height','76px');
        await expect(page.locator('#primary-sidebar')).toHaveCSS('width',collapsed?'76px':'228px');
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
        if(index===0)await page.screenshot({path:`/tmp/hirmos-catalog-desktop-${width}-${collapsed}.png`,animations:'disabled'});
      }
      const row=page.locator('.detail-tracks .track-row').first();
      const favorite=row.locator('.track-row__favorite');
      const before=await favorite.getAttribute('aria-pressed');await favorite.click();
      await expect(favorite).toHaveAttribute('aria-pressed',before==='true'?'false':'true');
      await expect(row).not.toHaveClass(/track-row--playing/);
      await row.locator('.track-row__play').click();await expect(row).toHaveClass(/track-row--playing/);
      await row.locator('.track-row__play').click();await expect(row).not.toHaveClass(/track-row--playing/);
    });
});
