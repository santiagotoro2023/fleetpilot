// Icons of FleetPilot: the line icons of the design system, plus this app's own,
// drawn the same way with s() (24x24 grid, stroke 1.8, round caps, see spec/01-design.md).
import { I as CORE, s } from './core/icons.js';

export const I = {
  ...CORE,
  // The menu
  gauge: s('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1" fill="currentColor"/>'),
  server: s('<rect x="3.5" y="4" width="17" height="6.5" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5"/><path d="M7 7.2h.01M7 16.8h.01M11 7.2h6M11 16.8h6"/>'),
  subnet: s('<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>'),
  flow: s('<rect x="3" y="3.5" width="7" height="5" rx="1.2"/><rect x="14" y="15.5" width="7" height="5" rx="1.2"/><path d="M6.5 8.5v3.5a2 2 0 0 0 2 2h7"/><path d="M13 12l2.5 2-2.5 2"/>'),
  // In the pages
  key: s('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2"/>'),
  group: s('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M7 13h4M7 16h7"/>'),
  user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  shield: s('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  sync: s('<path d="M20 11a8 8 0 0 0-14.3-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.5L20 16"/><path d="M20 20v-4h-4"/>'),
  copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  tag: s('<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z"/><circle cx="8" cy="8" r="1.4"/>'),
  doc: s('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'),
  stop: s('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  search: s('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>')
};
export { s };
