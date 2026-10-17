import { expect, test } from '@playwright/test';

test.skip(process.env.HIRMOS_LYRICS_LAB !== '1', 'Requires the synthetic lyrics lookup fixture');

test('renders rescued lyrics and source fallbacks without changing the player layout', async ({ page, request }) => {
  const origin = process.env.HIRMOS_E2E_ORIGIN ?? '';
  if (origin !== 'http://127.0.0.1:3313') throw new Error('Only the local lyrics fixture is allowed');
  const login = await request.post(`${origin}/api/auth/login`, {
    data: { email: 'listener@example.test', password: 'Fixture-only-2026!' },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/library');
  await page.locator('a[href^="/albums/"]').first().click();
  await expect(page.locator('app-album h1')).toHaveText('Prueba de continuidad');
  await page.getByRole('button', { name: 'Reproducir álbum', exact: true }).click();
  await page.getByRole('button', { name: 'Mostrar letra', exact: true }).click();
  const panel = page.locator('app-lyrics-panel');
  await expect(panel).toContainText('Letra sintética LRCLIB: búsqueda validada.');
  for (const title of ['Segunda señal', 'Tercera señal', 'Cuarta señal']) {
    await page.getByRole('button', { name: `Reproducir ${title}`, exact: true }).first().click();
    await expect(panel).toContainText(title);
    await expect(panel).toContainText(title === 'Segunda señal'
      ? 'Letra sintética LRCLIB: búsqueda validada.'
      : 'Letra sintética guardada para la prueba offline.');
  }
  await expect(page.locator('.player-bar')).toHaveCSS('height', '76px');
  const requestsBefore = (await (await request.get(`${origin}/__fixture/lyrics-requests`)).json()).requests;
  for (const title of ['Primera señal', 'Segunda señal']) {
    const calls = requestsBefore.filter((call: { title: string }) => call.title === title);
    expect(calls.map((call: { operation: string }) => call.operation))
      .toEqual(title === 'Primera señal' ? ['get', 'get'] : ['get', 'get', 'search']);
  }
  await page.getByRole('button', { name: 'Reproducir Primera señal', exact: true }).first().click();
  await expect(panel).toContainText('Primera señal');
  await expect(panel).toContainText('Letra sintética LRCLIB: búsqueda validada.');
  const requestsAfter = (await (await request.get(`${origin}/__fixture/lyrics-requests`)).json()).requests;
  expect(requestsAfter).toEqual(requestsBefore); // durable positive cache, no second download
  await page.screenshot({ path: '/tmp/hirmos-lyrics-dev.png', fullPage: true });
});
