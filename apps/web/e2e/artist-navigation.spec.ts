import { expect, test, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.skip(process.env.HIRMOS_ARTIST_NAVIGATION_LAB !== '1', 'Requires the isolated --artist-navigation fixture');
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
let albumName = 'Prueba de continuidad';
test.beforeAll(async ({request}) => {
  if (process.env.HIRMOS_E2E_ORIGIN !== 'http://127.0.0.1:3313') throw Error('Loopback fixture required');
  if (process.env.HIRMOS_FIXTURE_CATALOG_FILE) {
    albumName = JSON.parse(await readFile(process.env.HIRMOS_FIXTURE_CATALOG_FILE, 'utf8')).albums[0].name;
  }
  const response = await request.post('/api/auth/login', {data: {email:'listener@example.test',password:'Fixture-only-2026!'}});
  expect(response.status()).toBe(200);cookies = (await request.storageState()).cookies;
});
for (const width of [320,360,390,412,800,1280]) {
  test(`artist identity, links and layout at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:900});await page.context().addCookies(cookies);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/');
    const card = page.locator('.album-card').filter({has:page.locator('strong',{hasText:albumName})}).first();
    const artistLink = card.locator('small a');
    const primaryPath = (await artistLink.getAttribute('href'))!;
    await artistLink.click();
    await expect(page.locator('app-artist h1')).toBeVisible();
    const primary = await (await page.request.get(`/api/library${primaryPath}`)).json();
    const decoded = Buffer.from(primary.id, 'base64url').toString();
    const alias = Buffer.from(`${decoded}-alias`).toString('base64url');
    const aliasPath = `/artists/${alias}`;
    const aliasResult = await (await page.request.get(`/api/library${aliasPath}`)).json();
    expect(aliasResult).toEqual(primary);expect(primary.songCount).toBeGreaterThan(0);
    await page.goto(aliasPath);
    await expect(page.locator('app-artist h1')).toHaveText(primary.name);
    await expect(page.locator('.artist-discography .album-card')).toHaveCount(primary.albums.length);
    for (const album of await page.locator('.artist-discography .album-card').all()) await expect(album).toBeVisible();
    const heading = await page.locator('.artist-hero h1').boundingBox();
    expect(heading!.x + heading!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    await page.reload();await expect(page.locator('app-artist h1')).toHaveText(primary.name);
    if (width > 760) await expect(page.locator('#primary-sidebar')).toHaveCSS('width','228px');
    await page.screenshot({path:`/tmp/hirmos-artist-navigation-${width}.png`,fullPage:true,animations:'disabled'});
    // Follow cover -> album -> artist, without changing the selected track.
    await page.locator('.artist-discography .album-card').filter({has:page.locator('strong',{hasText:albumName})}).click();
    await expect(page.locator('app-album h1')).toBeVisible();
    const selectedTitle = (await page.locator('.detail-tracks .track-row__title').first().textContent())!.trim();
    await page.locator('.detail-tracks .track-row__play').first().click();
    await expect(page.locator('.player-track strong')).toHaveText(selectedTitle);
    const miniArtist = page.locator('.player-track .entity-links a').first();
    await miniArtist.click();
    await expect(page.locator('app-artist h1')).toHaveText(primary.name);
    await expect(page.locator('.mobile-now-playing')).toHaveCount(0);
    if (width <= 700) {
      // Title/cover retain the expand action; metadata opens actual destinations.
      const titleBox = (await page.locator('.player-track strong').boundingBox())!;
      await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
      await expect(page.locator('.mobile-now-playing')).toBeVisible();
      await page.locator('.mobile-now-playing__metadata a[href^="/albums/"]').click();
      await expect(page.locator('.mobile-now-playing')).toHaveCount(0);
      await expect(page.locator('app-album h1')).toBeVisible();
      await page.screenshot({path:`/tmp/hirmos-artist-linked-album-${width}.png`});
      await page.goBack();
      await expect(page.locator('app-artist h1')).toHaveText(primary.name);
      await expect(page.locator('.mobile-now-playing')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

test('search and habit album artist links, image hero and narrow layout', async ({page}) => {
  await page.setViewportSize({width:360,height:900});await page.context().addCookies(cookies);
  await page.goto(`/search?q=${encodeURIComponent(albumName)}`);
  const card=page.locator('.album-card').filter({has:page.locator('strong',{hasText:albumName})}).first();
  const path=(await card.locator('small a').getAttribute('href'))!;
  await card.locator('small a').click();
  const artist=await (await page.request.get(`/api/library${path}`)).json();
  await expect(page.locator('app-artist h1')).toHaveText(artist.name);
  // The reported overflow used an img, whose intrinsic size differs from a span.
  await page.route('**/api/library/artists/*',async route=>{
    const response=await route.fetch();const data=await response.json();
    await route.fulfill({response,json:{...data,coverUrl:'/icons/hirmos-192.png'}});
  });
  await page.reload();await expect(page.locator('.artist-hero > img')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(360);
  await page.route('**/api/library/habits?*',async route=>{
    if(new URL(route.request().url()).searchParams.get('kind')!=='albums')return route.continue();
    const album=artist.albums[0];
    await route.fulfill({json:{kind:'albums',period:'30d',dataSince:null,artists:[],tracks:[],nextCursor:null,
      albums:[{...album,artistId:artist.id,artist:artist.name,playStarts:1,qualifiedPlays:1,importedPlays:0,listenedMs:1000,estimated:false,trackCount:1}]}});
  });
  await page.goto('/habits');await page.getByRole('button',{name:'Álbumes',exact:true}).click();
  await page.locator('.habit-detail-card small a').click();
  await expect(page.locator('app-artist h1')).toHaveText(artist.name);
});
