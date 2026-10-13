import { Component, inject, input } from '@angular/core';
import { DownloadsService } from '../offline/downloads.service';
import { AppIconComponent } from './app-icon.component';

@Component({selector:'app-download-badge',imports:[AppIconComponent],template:`
  @if(downloads.ready().has(reference())){<span tabindex="0" role="img" aria-label="Descargada en este navegador" title="Descargada en este navegador"><app-icon name="downloaded" /><span class="hint" aria-hidden="true">Descargada en este navegador</span></span>}
`,styles:`:host{display:inline-flex;width:20px;flex:0 0 20px;align-items:center;justify-content:center}span[role]{display:inline-flex;position:relative;align-items:center;color:#8cdbad;font-size:16px;outline-offset:3px}.hint{display:none;position:absolute;right:0;bottom:calc(100% + 8px);z-index:10;background:#20252c;color:#fff;padding:8px 12px;border-radius:6px;font-size:12px;white-space:nowrap}span[role]:is(:focus,:hover) .hint{display:block}`})
export class DownloadBadgeComponent {
  protected readonly downloads=inject(DownloadsService);
  readonly reference=input.required<string>();
}
