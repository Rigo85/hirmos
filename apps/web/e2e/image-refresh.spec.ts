import { expect, test } from '@playwright/test';

test.skip(process.env.HIRMOS_IMAGE_LAB !== '1', 'Requires the opt-in image cache fixture');
test('updates the mounted cover after a selective refresh with a warm browser cache', async ({ page, request }) => {
  if (process.env.HIRMOS_E2E_ORIGIN !== 'http://127.0.0.1:3313') throw Error('Only the local image fixture is allowed');
  const login = await request.post('/api/auth/login', { data: { email: 'listener@example.test', password: 'Fixture-only-2026!' } });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  expect((await request.post('/__fixture/image-cache', { data: { version: 0 } })).ok()).toBe(true);
  await page.clock.install();
  await page.goto('/library');
  await page.locator('a[href^="/albums/"]').first().click();
  const cover = page.locator('img.detail-cover,.detail-cover img').first();
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(1);
  const initial = await cover.getAttribute('src');
  expect(initial).toMatch(/^blob:/);
  const beforeWidth = await cover.evaluate((image: HTMLImageElement) => image.naturalWidth);
  const revalidate = async () => {
    await page.clock.fastForward(31000);
    const checked = page.waitForResponse(response => response.url().includes('/api/music/covers/')
      && response.request().headers()['if-none-match'] !== undefined);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await checked).status()).toBe(304);
  };
  // Actual HTTP 200 static placeholder, then mislabelled HTML. Both must keep
  // the warm browser's original photo; only a usable new image may replace it.
  expect((await request.post('/__fixture/image-cache', { data: { version: 2 } })).ok()).toBe(true);
  await revalidate();
  await expect(cover).toHaveAttribute('src', initial!);
  expect((await request.post('/__fixture/image-cache', { data: { version: 3 } })).status()).toBe(500);
  await revalidate();
  await expect(cover).toHaveAttribute('src', initial!);
  expect((await request.post('/__fixture/image-cache', { data: { version: 1 } })).ok()).toBe(true);
  await page.clock.fastForward(31000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(cover).not.toHaveAttribute('src', initial!);
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(192);
  expect(beforeWidth).not.toBe(192);
  const refreshed = await cover.getAttribute('src');
  await page.clock.fastForward(31000);
  const conditional = page.waitForResponse(response => response.url().includes('/api/music/covers/') && response.request().headers()['if-none-match'] !== undefined);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const response = await conditional;
  expect(response.status()).toBe(304);
  expect(response.headers()['cache-control']).toBe('private, no-cache');
  expect(await cover.getAttribute('src')).toBe(refreshed);
  await page.screenshot({ path: '/tmp/hirmos-image-refresh-chrome.png' });
  expect((await request.post('/__fixture/image-cache', { data: { version: 0 } })).ok()).toBe(true);
});
