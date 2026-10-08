// Icons of @@APP_NAME@@: the line icons of the design system, plus this app's own,
// drawn the same way with s() (24x24 grid, stroke 1.8, round caps, see spec/01-design.md).
import { I as CORE, s } from './core/icons.js';

export const I = {
  ...CORE
  // myicon: s('<path d="…"/>')
};
export { s };
