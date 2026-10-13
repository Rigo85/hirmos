import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RenewAccessComponent } from './shared/renew-access.component';
import { ApplicationUpdateService } from './offline/application-update.service';
import { OfflineListenSender } from './offline/offline-listens.service';

@Component({
  imports: [RouterOutlet, RenewAccessComponent],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  // Subscribe before routes load; notices remain contextual in Descargas.
  private readonly updates = inject(ApplicationUpdateService);
  private readonly listens = inject(OfflineListenSender);
}
