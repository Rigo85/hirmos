import { expect, test } from '@playwright/test';

test.skip(process.env.HIRMOS_NOTICE_LAB !== '1', 'Requires the isolated playback fixture');

test('a fresh omission retires after recovery and stays in history across other plays and reload', async ({ page, request }) => {
  test.setTimeout(90_000);
  if (process.env.HIRMOS_E2E_ORIGIN !== 'http://127.0.0.1:3313') throw Error('Local fixture only');
  const control = (mode: string) => request.post('http://127.0.0.1:3314/__fixture/state',
    { data: { mode, track: '1' } });
  expect((await control('missing')).ok()).toBe(true);
  const login = await request.post('/api/auth/login', { data: {
    email: 'listener@example.test', password: 'Fixture-only-2026!',
  } });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/music/tracks/**/stream*', async route => {
    const ref = new URL(route.request().url()).pathname.split('/').at(-2)!;
    if (Buffer.from(ref, 'base64url').toString().endsWith('\0' + '2')) await gate;
    await route.continue();
  });
  const notice = page.getByRole('region', { name: 'Incidencias de reproducción' });
  const bar = page.locator('.player-bar');
  try {
    await page.goto('/library');
    await page.locator('a[href^="/albums/"]').first().click();
    await page.getByRole('button', { name: 'Reproducir álbum', exact: true }).click();
    const replace = page.getByRole('button', { name: /Reemplazar/ });
    if (await replace.isVisible()) await replace.click();
    await expect(notice).toContainText('Omitimos «Primera señal»', { timeout: 35_000 });
    release();
    await expect(bar).toContainText('Segunda señal');
    await expect(notice).toBeHidden({ timeout: 15_000 });
    expect((await control('healthy')).ok()).toBe(true);
    for (const title of ['Tercera señal', 'Primera señal']) {
      await page.getByRole('button', { name: `Reproducir ${title}`, exact: true }).first().click();
      await expect(bar).toContainText(title);
      await expect(notice).toBeHidden();
    }
    await page.reload();
    await expect(bar).toContainText('Primera señal');
    await expect(notice).toBeHidden();
    await page.getByRole('button', { name: 'Mostrar cola', exact: true }).click();
    await page.getByRole('button', { name: 'Incidencias', exact: true }).click();
    await expect(page.getByLabel('Historial de incidencias')).toContainText('Omitimos «Primera señal»');
    await expect(page.getByLabel('Historial de incidencias')).toContainText('Registro anterior');
  } finally {
    release();
    await control('healthy');
  }
});
