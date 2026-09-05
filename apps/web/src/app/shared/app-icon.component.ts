import { Component, input } from '@angular/core';

export type AppIconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'close'
  | 'device'
  | 'home'
  | 'library'
  | 'lyrics'
  | 'menu'
  | 'next'
  | 'panel-close'
  | 'panel-open'
  | 'pause'
  | 'play'
  | 'previous'
  | 'queue'
  | 'search'
  | 'shuffle'
  | 'settings'
  | 'users'
  | 'volume';

@Component({
  selector: 'app-icon',
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      @switch (name()) {
        @case ('arrow-left') {
          <path d="m14.5 6-6 6 6 6" />
        }
        @case ('arrow-right') {
          <path d="m9.5 6 6 6-6 6" />
        }
        @case ('home') {
          <path d="M3.5 10.7 12 3.8l8.5 6.9" />
          <path d="M5.6 9.6v10.1h12.8V9.6M9.4 19.7v-6.1h5.2v6.1" />
        }
        @case ('library') {
          <rect x="3.7" y="4" width="4.2" height="16" rx="1" />
          <rect x="9.9" y="4" width="4.2" height="16" rx="1" />
          <path d="m16.2 5.2 3.4-1 3.8 14.3-3.4.9z" />
        }
        @case ('search') {
          <circle cx="10.8" cy="10.8" r="6.7" />
          <path d="m15.7 15.7 4.1 4.1" />
        }
        @case ('menu') {
          <path d="M4 7h16M4 12h16M4 17h16" />
        }
        @case ('previous') {
          <path d="M6 5v14M18.5 5.8 9 12l9.5 6.2z" />
        }
        @case ('next') {
          <path d="M18 5v14M5.5 5.8 15 12l-9.5 6.2z" />
        }
        @case ('panel-close') {
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M9 4v16m6.5-5.2L12.7 12l2.8-2.8" />
        }
        @case ('panel-open') {
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M9 4v16m3.5-10.8 2.8 2.8-2.8 2.8" />
        }
        @case ('play') {
          <path class="icon-fill" d="m8.2 5.5 10 6.5-10 6.5z" />
        }
        @case ('pause') {
          <rect class="icon-fill" x="6.7" y="5.2" width="3.8" height="13.6" rx="1" />
          <rect class="icon-fill" x="13.5" y="5.2" width="3.8" height="13.6" rx="1" />
        }
        @case ('queue') {
          <path d="M4 6.5h10M4 12h10M4 17.5h7" />
          <path class="icon-fill" d="m16 13.8 5 3.2-5 3.2z" />
        }
        @case ('shuffle') {
          <path d="M4 7h2.5c4.7 0 6.3 10 11 10H20" />
          <path d="m17 14 3 3-3 3M4 17h2.5c1.8 0 3.2-1.5 4.4-3.3M13.2 8.9C14.4 7.7 15.8 7 17.5 7H20" />
          <path d="m17 4 3 3-3 3" />
        }
        @case ('volume') {
          <path d="M4 10v4h3.3l4.2 3.6V6.4L7.3 10zM15.3 8.8a4.6 4.6 0 0 1 0 6.4M17.9 6.5a7.8 7.8 0 0 1 0 11" />
        }
        @case ('lyrics') {
          <path d="M6 5.3h9.2M6 9.2h12M6 13.1h8.4M6 17h5.5" />
          <path d="M18 13.7v4.2a2.3 2.3 0 1 1-1.4-2.1l1.4.4" />
        }
        @case ('users') {
          <circle cx="9" cy="8.2" r="3.1" /><path d="M3.8 19.2v-1.1A5.2 5.2 0 0 1 9 12.9a5.2 5.2 0 0 1 5.2 5.2v1.1M16.2 10.8a2.6 2.6 0 1 0-1.7-4.6M16.8 13.2a4.4 4.4 0 0 1 3.4 4.3v.9" />
        }
        @case ('settings') {
          <circle cx="12" cy="12" r="3" />
          <path d="M19.2 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.5 1a7.8 7.8 0 0 0-2.6-1.5L13.8 2h-4l-.4 3.1a7.8 7.8 0 0 0-2.5 1.5l-2.5-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.5-1a7.8 7.8 0 0 0 2.5 1.5l.4 3.1h4l.4-3.1a7.8 7.8 0 0 0 2.5-1.5l2.5 1 2-3.4z" />
        }
        @case ('device') {
          <rect x="4" y="3.8" width="16" height="11.2" rx="1.5" /><path d="M8.3 20.2h7.4M12 15v5" />
        }
        @case ('close') {
          <path d="m6 6 12 12M18 6 6 18" />
        }
      }
    </svg>
  `,
  styles: [`
    :host { display: inline-grid; width: 1em; height: 1em; flex: 0 0 auto; place-items: center; }
    svg { display: block; width: 100%; height: 100%; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .icon-fill { fill: currentColor; stroke: none; }
  `],
})
export class AppIconComponent {
  public readonly name = input.required<AppIconName>();
}
