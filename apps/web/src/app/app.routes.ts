import { Routes } from '@angular/router';
import { authGuard, localProfileGuard } from './core/auth.guard';
import { adminGuard } from './core/admin.guard';

export const routes: Routes = [
  { path: 'access', loadComponent: () => import('./features/local-access/access-gate.component').then(m => m.AccessGateComponent) },
  { path:'lab/local-session',canMatch:[()=>['localhost','127.0.0.1','[::1]'].includes(location.hostname)],loadComponent:()=>import('./features/local-session-lab/local-session-lab.component').then(m=>m.LocalSessionLabComponent) },
  { path:'local',canActivate:[localProfileGuard],loadComponent:()=>import('./features/local-access/local-access.component').then(m=>m.LocalAccessComponent) },
  {
    path: 'lab/download-storage',
    canMatch: [() => ['localhost','127.0.0.1','[::1]'].includes(location.hostname)],
    canActivate: [authGuard],
    loadComponent: () => import('./features/storage-lab/storage-lab.component').then(m => m.StorageLabComponent),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then((module) => module.LoginComponent),
  },
  {
    path: 'aceptar-invitacion',
    loadComponent: () =>
      import('./features/accept-invitation/accept-invitation.component').then(
        (module) => module.AcceptInvitationComponent,
      ),
  },
  {
    path: 'recuperar',
    loadComponent: () =>
      import('./features/recovery/recovery.component').then(
        (module) => module.RecoveryComponent,
      ),
  },
  {
    path: 'admin/users',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./features/admin-users/admin-users.component').then(
        (module) => module.AdminUsersComponent,
      ),
  },
  {
    path: 'admin/backups', canActivate: [adminGuard],
    loadComponent: () => import('./features/admin-backups/admin-backups.component').then(m => m.AdminBackupsComponent),
  },
  {
    path: 'admin/source',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./features/admin-source/admin-source.component').then(
        (module) => module.AdminSourceComponent,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/shell/player-shell.component').then((module) => module.PlayerShellComponent),
    children: [
      { path:'downloads',loadComponent:()=>import('./features/downloads/downloads.component').then(m=>m.DownloadsComponent) },
      { path: 'account', loadComponent: () => import('./features/account/account.component').then(m => m.AccountComponent) },
      { path:'playlists',loadComponent:()=>import('./features/playlists/playlists.component').then(m=>m.PlaylistsComponent) },
      { path:'playlists/:id',loadComponent:()=>import('./features/playlists/playlists.component').then(m=>m.PlaylistsComponent) },
      {
        path: '',
        loadComponent: () =>
          import('./features/home/home.component').then((module) => module.HomeComponent),
      },
      {
        path: 'library',
        loadComponent: () =>
          import('./features/library/library.component').then((module) => module.LibraryComponent),
      },
      {
        path: 'search',
        loadComponent: () =>
          import('./features/search/search.component').then((module) => module.SearchComponent),
      },
      {
        path: 'activity/:kind',
        loadComponent: () =>
          import('./features/activity/activity.component').then((module) => module.ActivityComponent),
      },
      {
        path: 'habits',
        loadComponent: () =>
          import('./features/habits/habits.component').then((module) => module.HabitsComponent),
      },
      {
        path: 'favorites',
        loadComponent: () =>
          import('./features/favorites/favorites.component').then(
            (module) => module.FavoritesComponent,
          ),
      },
      {
        path: 'genres/:name',
        loadComponent: () =>
          import('./features/genre/genre.component').then((module) => module.GenreComponent),
      },
      {
        path: 'albums/:id',
        loadComponent: () =>
          import('./features/album/album.component').then((module) => module.AlbumComponent),
      },
      {
        path: 'artists/:id',
        loadComponent: () =>
          import('./features/artist/artist.component').then((module) => module.ArtistComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
