import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { adminGuard } from './core/admin.guard';

export const routes: Routes = [
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
